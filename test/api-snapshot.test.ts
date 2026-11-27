import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Timer } from '../src/jobs/runner.js';
import { fromTabs, REFRESH_MS, SNAPSHOT_TABS, startRefresher, type RefresherDeps } from '../src/api/snapshot.js';
import type { Row, SheetRow } from '../src/sheet-rows.js';
import { league } from './fixtures.js';

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const match = (match_id: string, status: string): Row<'matches'> => ({
  match_id, season: '5', stage: 'Regular', week: '1', gym_left_id: 'G022', gym_right_id: 'G025',
  score_left: '9', score_right: '10', status, tab_link: '', submitted_by: '', submitted_at: '2026-11-22T18:04:11.482Z',
});
const game = (match_id: string, n: number): Row<'games'> => ({
  match_id, game_number: String(n), trainer_left: '', deck_left: '', result_left: 'DQL', result_right: 'DQW', deck_right: '', trainer_right: '',
});
const rows = <T>(values: T[]) => values.map((v, i) => ({ rowNumber: i + 2, values: v }));

test('the snapshot reads the 8 tabs the endpoints need, in that order', () => {
  assert.deepEqual([...SNAPSHOT_TABS], ['gyms', 'trainers', 'decks', 'seasons', 'divisions', 'matches', 'matchRosters', 'games']);
});

test('a pending match is not served, and neither are its games or rosters', () => {
  const l = league();
  const built = fromTabs([
    l.gyms, l.trainers, l.decks, l.seasons, [],
    rows([match('M0001', 'complete'), match('M0002', 'pending')]),
    rows([
      { match_id: 'M0001', gym_id: 'G022', discord_id: '1100000000000000001' },
      { match_id: 'M0002', gym_id: 'G022', discord_id: '1100000000000000002' },
    ]) as SheetRow<'matchRosters'>[],
    rows([game('M0001', 1), game('M0002', 1), game('M0002', 2)]),
  ]);
  assert.deepEqual(built.matches.map((m) => m.match_id), ['M0001']);
  assert.deepEqual(built.games.map((g) => g.match_id), ['M0001']);
  assert.deepEqual(built.matchRosters.map((r) => r.match_id), ['M0001']);
  assert.equal(built.gyms.length, l.gyms.length);
  assert.ok(!('rowNumber' in built.gyms[0]), 'rows are values only');
});

// A refresher on fake timers, whose reads resolve when the test says so.
function harness(read: RefresherDeps<number>['read']) {
  const timers: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = [];
  const logs: string[] = [];
  let now = new Date('2026-11-27T12:00:00.000Z');
  const refresher = startRefresher<number>({
    read,
    now: () => now,
    setTimeout: (fn, ms): Timer => {
      const t = { fn, ms, cleared: false, fired: false };
      timers.push(t);
      return { clear: () => void (t.cleared = true) };
    },
    log: (m) => void logs.push(m),
  });
  const waiting = () => timers.filter((t) => !t.fired && !t.cleared);
  const tick = async (advanceMs = REFRESH_MS) => {
    const [t] = waiting();
    assert.ok(t, 'a timer should be waiting');
    now = new Date(now.getTime() + advanceMs);
    t.fired = true;
    t.fn();
    await settle();
  };
  return { refresher, timers, waiting, logs, tick };
}

test('reads at once, then every 60 seconds on one timer chain', async () => {
  let reads = 0;
  const h = harness(async () => ++reads);
  await settle();
  assert.equal(reads, 1);
  assert.deepEqual(h.refresher.current(), { value: 1, asOf: '2026-11-27T12:00:00.000Z' });
  assert.equal(h.waiting().length, 1);
  assert.equal(h.waiting()[0].ms, REFRESH_MS);
  await h.tick();
  assert.equal(reads, 2);
  assert.deepEqual(h.refresher.current(), { value: 2, asOf: '2026-11-27T12:01:00.000Z' });
  assert.equal(h.waiting().length, 1, 'one timer at a time');
});

test('a throwing read keeps the last good snapshot', async () => {
  let reads = 0;
  const h = harness(async () => {
    reads++;
    if (reads === 2 || reads === 3) throw new Error("The League DB's Games tab doesn't have the columns the bot expects");
    return reads;
  });
  await settle();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.refresher.current(), { value: 1, asOf: '2026-11-27T12:00:00.000Z' }, 'still the first read');
  assert.match(h.logs[0], /read failed \(1 in a row\); serving the snapshot from 2026-11-27T12:00:00.000Z/);
  assert.match(h.logs[1], /2 in a row/);
  await h.tick();
  assert.equal(h.refresher.current()!.value, 4);
  assert.match(h.logs[2], /succeeded after 2 failed/);
  assert.equal(h.waiting().length, 1, 'failures keep the chain going');
});

test('nothing is served until the first read succeeds', async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error('quota');
    return 1;
  });
  await settle();
  assert.equal(h.refresher.current(), undefined);
  assert.match(h.logs[0], /none loaded yet/);
  fail = false;
  await h.tick();
  assert.equal(h.refresher.current()!.value, 1);
});

test('a burst of refreshes coalesces into one read', async () => {
  let reads = 0;
  let release!: () => void;
  const h = harness(async () => {
    reads++;
    await new Promise<void>((r) => (release = r));
    return reads;
  });
  await settle();
  const burst = [h.refresher.refresh(), h.refresher.refresh(), h.refresher.refresh()];
  assert.equal(reads, 1, 'the first read is still running; the burst joins it');
  assert.equal(h.waiting().length, 0, 'the next timer waits for the read to end');
  release();
  await Promise.all(burst);
  await settle();
  assert.equal(reads, 1);
  assert.equal(h.waiting().length, 1);
});

test('stop waits for a read in progress, clears the timer and serves nothing after', async () => {
  let release!: () => void;
  let reads = 0;
  const h = harness(async () => {
    reads++;
    if (reads > 1) await new Promise<void>((r) => (release = r));
    return reads;
  });
  await settle();
  const timer = h.waiting()[0];
  timer.fired = true;
  timer.fn(); // the second read starts and hangs
  await settle();
  let stopped = false;
  const stopping = h.refresher.stop().then(() => void (stopped = true));
  await settle();
  assert.equal(stopped, false, 'waits for the read');
  assert.equal(h.refresher.current(), undefined, '503 from the moment stop is called');
  release();
  await stopping;
  await settle();
  assert.equal(h.waiting().length, 0, 'no timer re-armed after stop');
});

// A refresher whose reads fail while `failing` is true, recording its alerts.
function alerting(postFails = false) {
  const state = { failing: true, outages: [] as [string, number, string | undefined][], recoveries: [] as number[] };
  const timers: { fn: () => void; fired: boolean; cleared: boolean }[] = [];
  const logs: string[] = [];
  let reads = 0;
  startRefresher<number>({
    read: async () => {
      reads++;
      if (state.failing && reads > 1) throw new Error('quota exceeded');
      return reads;
    },
    now: () => new Date('2026-11-27T12:00:00.000Z'),
    setTimeout: (fn) => {
      const t = { fn, fired: false, cleared: false };
      timers.push(t);
      return { clear: () => void (t.cleared = true) };
    },
    log: (m) => void logs.push(m),
    onOutage: async (err, failures, asOf) => {
      if (postFails) throw new Error('Discord is down');
      state.outages.push([(err as Error).message, failures, asOf]);
    },
    onRecovery: async (failures) => void state.recoveries.push(failures),
  });
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await settle();
      const t = timers.find((x) => !x.fired && !x.cleared)!;
      t.fired = true;
      t.fn();
    }
    await settle();
  };
  return { state, logs, ticks };
}

test('staff are alerted once, at the 10th failed read in a row, and once on recovery', async () => {
  const a = alerting();
  await a.ticks(9);
  assert.deepEqual(a.state.outages, [], 'nine minutes of failures: no alert yet');
  await a.ticks(1);
  assert.deepEqual(a.state.outages, [['quota exceeded', 10, '2026-11-27T12:00:00.000Z']]);
  await a.ticks(50);
  assert.equal(a.state.outages.length, 1, 'never repeated during the outage');
  assert.deepEqual(a.state.recoveries, []);
  a.state.failing = false;
  await a.ticks(1);
  assert.deepEqual(a.state.recoveries, [60]);
  await a.ticks(3);
  assert.deepEqual(a.state.recoveries, [60], 'one recovery message');
});

test('a short outage that recovers before 10 failures sends nothing', async () => {
  const a = alerting();
  await a.ticks(5);
  a.state.failing = false;
  await a.ticks(2);
  assert.deepEqual(a.state.outages, []);
  assert.deepEqual(a.state.recoveries, []);
});

test('a second outage gets its own alert', async () => {
  const a = alerting();
  await a.ticks(10);
  a.state.failing = false;
  await a.ticks(1);
  a.state.failing = true;
  await a.ticks(10);
  assert.equal(a.state.outages.length, 2);
});

test('an alert that fails to post is logged and the refresh carries on', async () => {
  const a = alerting(true);
  await a.ticks(10);
  assert.ok(a.logs.some((l) => l === 'could not post the outage alert: Discord is down'));
  await a.ticks(2);
  assert.ok(a.logs.at(-1)!.includes('12 in a row'), 'still reading every minute');
});
