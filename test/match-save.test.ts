import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldRetry } from '../src/google.js';
import { deleteRequests } from '../src/league-db.js';
import { LockTimeout } from '../src/locks.js';
import type { GymScore } from '../src/match/format.js';
import { parseMatch } from '../src/match/parse.js';
import { type SaveDeps, type SaveInput, SavePending, nextMatchId, saveMatch, tabLink } from '../src/match/save.js';
import { type SavePlan, validate } from '../src/match/validate.js';
import type { CrashPoint } from '../src/roster/approval.js';
import { firstRowOf, type SheetRow } from '../src/sheet-rows.js';
import { exampleMatch, league } from './fixtures.js';
import { FakeMatchStore } from './match-store-fake.js';

const SHEET_ID = '1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg';
const STAFF = '1300000000000000001';
const NOW = new Date('2026-11-18T12:00:00Z');

function examplePlan(): SavePlan {
  const { tab, cells } = exampleMatch();
  const v = validate(parseMatch(tab, cells), league());
  assert.deepEqual(v.errors, []);
  return v.plan!;
}

const input = (plan = examplePlan(), v: Partial<SaveInput> = {}): SaveInput => ({
  plan,
  spreadsheetId: SHEET_ID,
  gid: '123',
  submittedBy: STAFF,
  gyms: { left: { name: 'Phoenix', emote: ':phoenix~1:' }, right: { name: 'Summit', emote: ':summit:' } },
  ...v,
});

function harness(store = new FakeMatchStore(league())) {
  const announced: [GymScore, GymScore][] = [];
  const logged: string[] = [];
  let views = 0;
  const deps = (crashAt?: CrashPoint, extra: Partial<SaveDeps> = {}): SaveDeps => ({
    store,
    rebuildViews: async () => { views++; },
    announce: async (l, r) => { announced.push([l, r]); },
    crash: (p) => { if (p === crashAt) throw new Error(`stopped at ${p}`); },
    now: () => NOW,
    log: (message) => logged.push(message),
    ...extra,
  });
  return { store, deps, announced, logged, views: () => views };
}

// The four tabs' contents, for comparing two stores.
const contents = (s: FakeMatchStore) => JSON.parse(JSON.stringify(s.tabs));

// A plan for another pairing, from the Example Match's games.
const otherMatch = (plan: SavePlan, left: string, right: string): SavePlan => ({
  ...plan, identity: { ...plan.identity, gymLeftId: left, gymRightId: right },
});

const completeMatch = (n: number, v: Record<string, string | number> = {}) => ({
  match_id: `M${String(n).padStart(4, '0')}`, season: 5, stage: 'Regular', week: 1,
  gym_left_id: `X${n}a`, gym_right_id: `X${n}b`, score_left: 10, score_right: 8, status: 'complete',
  tab_link: '', submitted_by: '', submitted_at: '', ...v,
});

// ---- A clean save -------------------------------------------------------------

test('a clean save writes the expected rows in the expected order', async () => {
  const h = harness();
  const result = await saveMatch(input(), h.deps());
  assert.deepEqual(h.store.calls, ['readForSave', 'appendDecks', 'appendMatch', 'deleteMatchRows', 'appendRosters', 'appendGames', 'finalizeMatch']);
  assert.equal(h.views(), 1);
  assert.equal(h.announced.length, 1);

  const { matches, decks, games, matchRosters } = h.store.tabs;
  assert.deepEqual(matches, [{
    match_id: 'M0001', season: 5, stage: 'Regular', week: 1, gym_left_id: 'G022', gym_right_id: 'G025',
    score_left: 9, score_right: 10, status: 'complete', tab_link: tabLink(SHEET_ID, '123'),
    submitted_by: STAFF, submitted_at: '2026-11-18T12:00:00.000Z',
  }]);
  assert.equal(decks.length, 7);
  assert.ok(decks.every((d) => d.active === true), 'active is written as a boolean');
  assert.equal(matchRosters.length, 10);
  assert.deepEqual(matchRosters[0], { match_id: 'M0001', gym_id: 'G022', discord_id: '1100000000000000001' });
  assert.deepEqual(matchRosters[5], { match_id: 'M0001', gym_id: 'G025', discord_id: '1200000000000000001' });
  assert.deepEqual(games.map((g) => g.game_number), Array.from({ length: 19 }, (_, i) => i + 1));
  assert.deepEqual(games[10], {
    match_id: 'M0001', game_number: 11, trainer_left: '1100000000000000003', deck_left: 'Mega Blaziken ex Greninja',
    result_left: 'DQL', result_right: 'DQW', deck_right: 'Suicune ex Baxcalibur', trainer_right: '1200000000000000003',
  });

  assert.equal(result.kind, 'saved');
  if (result.kind !== 'saved') return;
  assert.equal(result.matchId, 'M0001');
  assert.equal(result.replaced, false);
  assert.equal(result.weekCount, 1);
  assert.equal(result.announcement, 'posted');
  assert.deepEqual(h.announced[0].map((g) => [g.name, g.score]), [['Phoenix', 9], ['Summit', 10]]);
});

test('match IDs go one after the highest, M0001 first', () => {
  const rows = (ids: string[]) => ids.map((match_id, i) => ({ rowNumber: i + 2, values: { match_id } as SheetRow<'matches'>['values'] }));
  assert.equal(nextMatchId([]), 'M0001');
  assert.equal(nextMatchId(rows(['M0001', 'M0007', 'M0003'])), 'M0008');
  assert.equal(nextMatchId(rows(['', 'manual', 'M0009'])), 'M0010');
  assert.equal(nextMatchId(rows(['M9999'])), 'M10000');
});

// ---- Crash points ----------------------------------------------------------------

const WRITE_POINTS: CrashPoint[] = ['match.decks', 'match.pending', 'match.delete', 'match.rosters', 'match.games', 'match.finalize'];

for (const point of WRITE_POINTS) {
  test(`stopped at ${point}, a re-submit ends where a clean save does, with no duplicate rows`, async () => {
    const clean = harness();
    await saveMatch(input(), clean.deps());

    const h = harness();
    await assert.rejects(saveMatch(input(), h.deps(point)), (err: Error) => {
      if (point === 'match.decks') return !(err instanceof SavePending);
      return err instanceof SavePending && err.matchId === 'M0001';
    });
    if (point !== 'match.finalize') {
      assert.ok(h.store.tabs.matches.every((m) => m.status !== 'complete'), 'nothing is complete before step 6');
    }
    assert.equal(h.announced.length, 0);

    const again = await saveMatch(input(), h.deps());
    assert.equal(again.kind, 'saved');
    assert.deepEqual(contents(h.store), contents(clean.store));
    if (again.kind === 'saved') assert.equal(again.matchId, 'M0001');
  });
}

test('stopped after step 6, the match is complete and the re-submit does not announce', async () => {
  // The first run never reached the announcement, and the score is unchanged,
  // so nothing announces it; the record says "not needed, score unchanged".
  const h = harness();
  await assert.rejects(saveMatch(input(), h.deps('match.finalize')), SavePending);
  assert.equal(h.store.tabs.matches[0].status, 'complete');
  const again = await saveMatch(input(), h.deps());
  assert.ok(again.kind === 'saved' && again.replaced && again.announcement === 'unchanged');
  assert.equal(h.announced.length, 0);
});

test('a failed announcement leaves the match complete and is reported as failed', async () => {
  const h = harness();
  const result = await saveMatch(input(), h.deps('match.announce'));
  assert.ok(result.kind === 'saved' && result.announcement === 'failed');
  assert.equal(h.store.tabs.matches[0].status, 'complete');
  assert.equal(h.announced.length, 0);
  assert.deepEqual(h.logged, ['M0001: the results announcement failed']);
});

test('a failed views rebuild is logged and the save stays complete', async () => {
  const views = harness();
  const v = await saveMatch(input(), views.deps('match.views'));
  assert.ok(v.kind === 'saved' && v.viewsFailed);
  assert.equal(views.store.tabs.matches[0].status, 'complete');
  assert.deepEqual(views.logged, ['M0001: rebuilding the views failed']);
});

test('a save that fails partway is pending; the re-submit finishes it under the same ID and announces', async () => {
  const h = harness();
  await assert.rejects(saveMatch(input(), h.deps('match.games')), SavePending);
  assert.equal(h.store.tabs.matches[0].status, 'pending');
  const again = await saveMatch(input(), h.deps());
  assert.ok(again.kind === 'saved' && again.matchId === 'M0001' && again.replaced);
  assert.equal(h.announced.length, 1, 'no earlier complete row, so it announces');
  assert.equal(h.store.tabs.matches.length, 1);
});

// ---- Re-submits --------------------------------------------------------------------

test('a re-submit with a changed score replaces the rows and announces', async () => {
  const h = harness();
  await saveMatch(input(), h.deps());
  const plan = examplePlan();
  plan.score = { left: 10, right: 9 };
  plan.games = plan.games.slice(0, 18);
  const result = await saveMatch(input(plan), h.deps());
  assert.ok(result.kind === 'saved' && result.replaced && result.announcement === 'posted');
  assert.equal(h.announced.length, 2);
  assert.equal(h.store.tabs.games.length, 18);
  assert.equal(h.store.tabs.matchRosters.length, 10);
  assert.equal(h.store.tabs.matches.length, 1);
  assert.deepEqual([h.store.tabs.matches[0].score_left, h.store.tabs.matches[0].score_right], [10, 9]);
  assert.ok(result.kind === 'saved' && result.prior?.scoreLeft === '9', 'the earlier score, for the record post');
});

test('a re-submit with the same score replaces the rows and does not announce', async () => {
  const h = harness();
  await saveMatch(input(), h.deps());
  const result = await saveMatch(input(), h.deps());
  assert.ok(result.kind === 'saved' && result.replaced && result.announcement === 'unchanged');
  assert.equal(h.announced.length, 1);
  assert.equal(h.store.tabs.games.length, 19);
  assert.equal(h.store.tabs.decks.length, 7, 'decks already added are matched, not added again');
  assert.equal(result.weekCount, 1, 'a re-submit does not change the week count');
});

test('a re-submit with the sides swapped is the same match and not a score change', async () => {
  const h = harness();
  await saveMatch(input(), h.deps());
  const plan = examplePlan();
  plan.identity = { ...plan.identity, gymLeftId: 'G025', gymRightId: 'G022' };
  plan.score = { left: 10, right: 9 };
  const gyms = { left: { name: 'Summit', emote: ':summit:' }, right: { name: 'Phoenix', emote: ':phoenix~1:' } };
  const result = await saveMatch(input(plan, { gyms }), h.deps());
  assert.ok(result.kind === 'saved' && result.matchId === 'M0001' && result.announcement === 'unchanged');
  assert.deepEqual([h.store.tabs.matches[0].gym_left_id, h.store.tabs.matches[0].score_left], ['G025', 10]);
});

test('every old row of the match is deleted, including a duplicate from an append that landed twice', async () => {
  const h = harness();
  await saveMatch(input(), h.deps());
  h.store.tabs.games.push(...h.store.tabs.games.slice(0, 19).map((g) => ({ ...g })));
  h.store.tabs.games.unshift({ match_id: 'M0000', game_number: 1 });
  await saveMatch(input(), h.deps());
  assert.equal(h.store.tabs.games.filter((g) => g.match_id === 'M0001').length, 19);
  assert.equal(h.store.tabs.games[0].match_id, 'M0000', 'other matches are untouched');
});

test('two Matches rows for one match refuse the save with nothing written', async () => {
  const h = harness();
  h.store.tabs.matches.push(completeMatch(1, { gym_left_id: 'G022', gym_right_id: 'G025' }), completeMatch(2, { gym_left_id: 'G025', gym_right_id: 'G022' }));
  const result = await saveMatch(input(), h.deps());
  assert.deepEqual(result, { kind: 'duplicate', matchIds: ['M0001', 'M0002'] });
  assert.deepEqual(h.store.calls, ['readForSave']);
});

// ---- Decks ---------------------------------------------------------------------------

test('a deck added by another save since validation is used under its spelling, not added twice', async () => {
  const h = harness();
  h.store.tabs.decks.push({ name: 'MEGA LUCARIO EX LUCARIO', active: true });
  await saveMatch(input(), h.deps());
  assert.equal(h.store.tabs.decks.length, 7);
  assert.equal(h.store.tabs.games[0].deck_left, 'MEGA LUCARIO EX LUCARIO');
});

// ---- The lock and the week cap ----------------------------------------------------------

test('two submits at once run one after the other and mint different IDs', async () => {
  const h = harness();
  const plan = { ...examplePlan(), weekCap: 16 };
  const [a, b] = await Promise.all([
    saveMatch(input(plan), h.deps()),
    saveMatch(input(otherMatch(plan, 'G022', 'G007')), h.deps()),
  ]);
  assert.ok(a.kind === 'saved' && b.kind === 'saved');
  assert.deepEqual([a.matchId, b.matchId], ['M0001', 'M0002']);
  const save = ['readForSave', 'appendDecks', 'appendMatch', 'deleteMatchRows', 'appendRosters', 'appendGames', 'finalizeMatch'];
  assert.deepEqual(h.store.calls, [...save, ...save.filter((c) => c !== 'appendDecks')], 'not interleaved');
  assert.equal(b.weekCount, 2);
});

test('a race for the last slot of the week lets only one through', async () => {
  const h = harness();
  for (let n = 1; n <= 15; n++) h.store.tabs.matches.push(completeMatch(n));
  const plan = { ...examplePlan(), weekCap: 16 };
  const [a, b] = await Promise.all([
    saveMatch(input(plan), h.deps()),
    saveMatch(input(otherMatch(plan, 'G007', 'G025')), h.deps()),
  ]);
  assert.ok(a.kind === 'saved' && a.weekCount === 16);
  assert.deepEqual(b, { kind: 'week-full', count: 16 });
  assert.equal(h.store.tabs.matches.length, 16);
});

test('the week cap inside the lock ignores pending rows and other weeks', async () => {
  const h = harness();
  for (let n = 1; n <= 14; n++) h.store.tabs.matches.push(completeMatch(n));
  h.store.tabs.matches.push(completeMatch(15, { status: 'pending' }), completeMatch(16, { week: 2 }));
  const result = await saveMatch(input({ ...examplePlan(), weekCap: 15 }), h.deps());
  assert.ok(result.kind === 'saved' && result.weekCount === 15);
});

test('a save that waits too long for the lock gives up with the busy reply and writes nothing', async () => {
  const h = harness();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const slow = harness(h.store);
  const first = saveMatch(input(), slow.deps(undefined, { rebuildViews: () => held }));
  await new Promise((r) => setTimeout(r, 20));
  const before = h.store.calls.length;
  await assert.rejects(saveMatch(input(otherMatch(examplePlan(), 'G022', 'G007')), h.deps(undefined, { lockWaitMs: 10 })), LockTimeout);
  assert.equal(h.store.calls.length, before);
  release();
  await first;
});

// ---- Sheets helpers ------------------------------------------------------------------------

test('row deletes go bottom-up, one request per run of adjacent rows, never the header', () => {
  const ranges = deleteRequests(7, [5, 3, 4, 9, 10, 4]).map((r) => r.deleteDimension.range);
  assert.deepEqual(ranges, [
    { sheetId: 7, dimension: 'ROWS', startIndex: 8, endIndex: 10 },
    { sheetId: 7, dimension: 'ROWS', startIndex: 2, endIndex: 5 },
  ]);
  assert.deepEqual(deleteRequests(7, []), []);
  assert.throws(() => deleteRequests(7, [1, 5]));
});

test('row deletes are not retried after a failure, but a rate-limited one is', () => {
  const call = (url: string, status?: number) =>
    shouldRetry({ config: { url, retryConfig: { currentRetryAttempt: 0, retry: 5 } }, ...(status && { response: { status } }) });
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/abc';
  assert.equal(call(`${base}:batchUpdate`, 500), false);
  assert.equal(call(`${base}:batchUpdate`), false, 'a timeout may have landed');
  assert.equal(call(`${base}:batchUpdate`, 429), true);
  assert.equal(call(`${base}/values:batchUpdate`, 500), true);
  assert.equal(call(`${base}/values/Games!A1:append`, 500), false);
  assert.equal(call(`${base}/values:batchGet`, 503), true);
});

test('the appended row number is read from the update range', () => {
  assert.equal(firstRowOf("'Matches'!A5:L5"), 5);
  assert.equal(firstRowOf('Games!A120:H138'), 120);
  assert.equal(firstRowOf("'Match rosters'!$A$7:$C$16"), 7);
});

test('a no-Trainer (//) game saves blank Trainers and decks, and adds no blank deck', async () => {
  const plan = examplePlan();
  plan.games[10] = { ...plan.games[10], trainerLeft: '', deckLeft: '', deckRight: '', trainerRight: '' };
  const h = harness();
  await saveMatch(input(plan), h.deps());
  const { decks, games } = h.store.tabs;
  assert.equal(decks.length, 7);
  assert.ok(decks.every((d) => d.name !== ''));
  assert.deepEqual(games[10], {
    match_id: 'M0001', game_number: 11, trainer_left: '', deck_left: '',
    result_left: 'DQL', result_right: 'DQW', deck_right: '', trainer_right: '',
  });
});
