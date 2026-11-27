// The list routes' filters and the Discord ID lookup, over HTTP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trainerIds } from '../src/api/ids.js';
import { createApi } from '../src/api/router.js';
import {
  BUILD, DISCORD_ID, FEED_KEY, FakeRefresher, LOOKUP_KEY, fixtureLeague, fixtureResources, serve, testConfig, type Served,
} from './api-fixtures.js';

const ids = trainerIds(BUILD.idSecret);
const LEFT_01 = '1100000000000000001';

async function withServer(fn: (s: Served) => Promise<void>, options: Parameters<typeof serve>[0] = {}) {
  const s = await serve(options);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const json = async (res: globalThis.Response) => ({ status: res.status, body: await res.json() });

// A league with a second match, in week 2 against G003, to filter between.
function twoMatches() {
  const l = fixtureLeague();
  l.matches.push({ ...l.matches[0], match_id: 'M0002', week: '2', gym_right_id: 'G003' });
  l.games.push(...l.games.filter((g) => g.match_id === 'M0001').map((g) => ({ ...g, match_id: 'M0002' })));
  return fixtureResources(l);
}

test('every route answers with the envelope and a count', async () => {
  await withServer(async (s) => {
    for (const [path, count] of [['/seasons', 1], ['/matches', 1], ['/gyms', 3], ['/trainers', 10], ['/decks', 7]] as const) {
      const { status, body } = await json(await s.get(path));
      assert.equal(status, 200, path);
      assert.deepEqual(Object.keys(body), ['data', 'meta'], path);
      assert.equal(body.meta.count, count, path);
      assert.equal(body.data.length, count, path);
    }
  });
});

test('/matches filters by season, stage, week and gym on either side', async () => {
  await withServer(async (s) => {
    const idsFor = async (q: string) => (await (await s.get(`/matches${q}`)).json()).data.map((m: { id: string }) => m.id);
    assert.deepEqual(await idsFor(''), ['M0001', 'M0002']);
    assert.deepEqual(await idsFor('?week=2'), ['M0002']);
    assert.deepEqual(await idsFor('?season=5&week=1'), ['M0001']);
    assert.deepEqual(await idsFor('?season=4'), []);
    assert.deepEqual(await idsFor('?stage=Regular'), ['M0001', 'M0002']);
    assert.deepEqual(await idsFor('?stage=Playoff'), []);
    assert.deepEqual(await idsFor('?gym_id=G003'), ['M0002'], 'right side');
    assert.deepEqual(await idsFor('?gym_id=G022'), ['M0001', 'M0002'], 'left side');
  }, { resources: twoMatches() });
});

test('/matches rejects filter values it cannot use', async () => {
  await withServer(async (s) => {
    for (const [q, message] of [
      ['?season=five', 'season must be a whole number.'],
      ['?week=-1', 'week must be a whole number.'],
      ['?stage=regular', 'stage must be one of Regular, Playoff, Playout.'],
      ['?gym_id=G999', 'No gym G999. Gym ids are as in /gyms.'],
      ['?since=2026-11-01', 'Unknown parameter since. This route takes season, stage, week, gym_id.'],
      ['?week=1&week=2', 'Give week once.'],
    ]) {
      assert.deepEqual(await json(await s.get(`/matches${q}`)), { status: 400, body: { error: { code: 'bad_request', message } } }, q);
    }
  });
});

test('/gyms filters by status and takes no season', async () => {
  await withServer(async (s) => {
    const { body } = await json(await s.get('/gyms?status=relegated'));
    assert.deepEqual(body.data.map((g: { id: string }) => g.id), ['G003']);
    assert.equal((await s.get('/gyms?status=Active')).status, 400);
    assert.equal((await s.get('/gyms?season=5')).status, 400);
  });
});

test('/trainers filters by gym and status', async () => {
  const l = fixtureLeague();
  l.trainers[0].status = 'inactive';
  await withServer(async (s) => {
    assert.equal((await json(await s.get('/trainers?gym_id=G025'))).body.meta.count, 5);
    assert.equal((await json(await s.get('/trainers?gym_id=G003'))).body.meta.count, 0);
    assert.deepEqual((await json(await s.get('/trainers?status=inactive'))).body.data.map((t: { id: string }) => t.id), [ids(LEFT_01)]);
    assert.equal((await json(await s.get('/trainers?gym_id=G022&status=active'))).body.meta.count, 4);
    assert.equal((await s.get('/trainers?status=left')).status, 400);
    assert.equal((await s.get('/trainers?gym_id=nope')).status, 400);
  }, { resources: fixtureResources(l) });
});

test('different query strings with different data get different ETags', async () => {
  await withServer(async (s) => {
    const week1 = (await s.get('/matches?week=1')).headers.get('etag');
    const week2 = (await s.get('/matches?week=2')).headers.get('etag');
    assert.ok(week1 && week2);
    assert.notEqual(week1, week2);
    const again = await s.get('/matches?week=2', { headers: { 'if-none-match': week2 } });
    assert.equal(again.status, 304);
  }, { resources: twoMatches() });
});

// ---- The lookup --------------------------------------------------------------

test('lookup: a member gets their trainer id and gym, with as_of and no count', async () => {
  await withServer(async (s) => {
    const res = await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY });
    assert.deepEqual(await json(res), {
      status: 200,
      body: { data: { trainer_id: ids(LEFT_01), gym_id: 'G022' }, meta: { as_of: '2026-11-27T12:00:00.000Z' } },
    });
  });
});

test('lookup: anyone with a Trainers row is found, whatever their status; no gym is null', async () => {
  const l = fixtureLeague();
  Object.assign(l.trainers[0], { gym_id: '', status: 'banned' });
  await withServer(async (s) => {
    const { body } = await json(await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY }));
    assert.deepEqual(body.data, { trainer_id: ids(LEFT_01), gym_id: null });
  }, { resources: fixtureResources(l) });
});

test('lookup: not a member is 404, not a Discord ID is 400, a parameter is 400', async () => {
  await withServer(async (s) => {
    assert.deepEqual(await json(await s.get('/trainers/by-discord/1999999999999999999', { key: LOOKUP_KEY })), {
      status: 404, body: { error: { code: 'not_found', message: 'Not a league member.' } },
    });
    assert.equal((await s.get('/trainers/by-discord/abc', { key: LOOKUP_KEY })).status, 400);
    assert.equal((await s.get('/trainers/by-discord/123', { key: LOOKUP_KEY })).status, 400);
    assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}?x=1`, { key: LOOKUP_KEY })).status, 400);
    assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY, method: 'POST' })).status, 405);
  });
});

test('lookup: the feed key is rejected, and no key is rejected', async () => {
  await withServer(async (s) => {
    assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}`, { key: FEED_KEY })).status, 401);
    assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}`, { key: null })).status, 401);
  });
});

test('lookup: limited at the 61st request in an hour, with Retry-After', async () => {
  let now = Date.parse('2026-11-27T12:00:00Z');
  await withServer(async (s) => {
    for (let i = 1; i <= 60; i++) {
      assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY })).status, 200, `request ${i}`);
      now += 1000;
    }
    const limited = await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '3540');
    assert.equal((await limited.json()).error.code, 'rate_limited');
    assert.equal((await s.get('/seasons')).status, 200, 'the lists are not limited');
    now += 3540_000;
    assert.equal((await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY })).status, 200);
  }, { now: () => now });
});

test('lookup: logged by key label and opaque id, hit or miss, never by Discord ID', async () => {
  await withServer(async (s) => {
    await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY });
    await s.get('/trainers/by-discord/1999999999999999999', { key: LOOKUP_KEY });
    const lookups = s.logs.filter((l) => l.startsWith('lookup '));
    assert.match(lookups[0], new RegExp(`^lookup \\S+Z pktr-lookup hit ${ids(LEFT_01)}$`));
    assert.match(lookups[1], new RegExp(`^lookup \\S+Z pktr-lookup miss ${ids('1999999999999999999')}$`));
    for (const line of s.logs) assert.doesNotMatch(line, DISCORD_ID, line);
  });
});

// ---- No Discord IDs ----------------------------------------------------------

test('no response from any route contains a Discord ID', async () => {
  await withServer(async (s) => {
    for (const path of ['/seasons', '/matches', '/gyms', '/trainers', '/decks']) {
      assert.doesNotMatch(await (await s.get(path)).text(), DISCORD_ID, path);
    }
    assert.doesNotMatch(await (await s.get(`/trainers/by-discord/${LEFT_01}`, { key: LOOKUP_KEY })).text(), DISCORD_ID);
  });
  // The fixture's rows do hold Discord IDs, in every place a response draws from.
  const l = fixtureLeague();
  for (const rows of [l.trainers, l.matchRosters, l.games, l.matches]) assert.match(JSON.stringify(rows), DISCORD_ID);
});

// ---- Settings ----------------------------------------------------------------

test('without API_ID_SECRET or API_LOGO_BASE_URL the API never starts, and says why', async () => {
  for (const missing of [{ idSecret: '' }, { logoBaseUrl: '' }]) {
    let started = 0;
    const logs: string[] = [];
    const api = createApi(testConfig(missing), {
      startRefresher: () => {
        started++;
        return new FakeRefresher(fixtureResources());
      },
      log: (m) => void logs.push(m),
    });
    api.start();
    assert.equal(started, 0);
    assert.match(logs[0], /^not started: API_(ID_SECRET|LOGO_BASE_URL) not set; every request gets 503$/);
  }
});
