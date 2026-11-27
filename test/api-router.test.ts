import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildResources } from '../src/api/map/index.js';
import { configFromEnv, createApi, loggedPath } from '../src/api/router.js';
import { AS_OF, DISCORD_ID, FakeRefresher, fixtureLeague, serve, testConfig } from './api-fixtures.js';

test('GET /seasons: the envelope, with count', async () => {
  const s = await serve();
  try {
    const res = await s.get('/seasons');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^application\/json/);
    assert.deepEqual(await res.json(), {
      data: [{ season: 5, start_date: '2026-11-01', end_date: '2026-12-31', active: true }],
      meta: { as_of: AS_OF, count: 1 },
    });
  } finally {
    await s.close();
  }
});

test('503 before start, before the first read lands, and from stop on', async () => {
  const notStarted = await serve({ start: false });
  const noSnapshot = await serve({ resources: null });
  try {
    for (const s of [notStarted, noSnapshot]) {
      const res = await s.get('/seasons');
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '10');
      assert.deepEqual(await res.json(), { error: { code: 'not_ready', message: 'Starting; try again shortly.' } });
    }
    // Before the key check: an unauthenticated caller learns only that it's starting.
    assert.equal((await noSnapshot.get('/seasons', { key: null })).status, 503);

    assert.equal((await notStarted.get('/nope')).status, 503);
  } finally {
    await notStarted.close();
    await noSnapshot.close();
  }

  const s = await serve();
  try {
    assert.equal((await s.get('/seasons')).status, 200);
    await s.api.stop();
    const res = await s.get('/seasons');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.message, 'Shutting down; try again shortly.');
  } finally {
    await s.close();
  }
});

test('API_ENABLED unset: the router passes everything on and never starts a read', async () => {
  let started = 0;
  const off = createApi(testConfig({ enabled: false }), {
    startRefresher: () => {
      started++;
      return new FakeRefresher();
    },
    log: () => {},
  });
  off.start();
  assert.equal(started, 0, 'no League DB reads');
  await off.stop();

  const s = await serve({ config: testConfig({ enabled: false }) });
  try {
    const res = await s.get('/seasons');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /json/, "express's own 404, as if not mounted");
    assert.deepEqual(s.logs, [], 'not even logged');
  } finally {
    await s.close();
  }
});

test('configFromEnv: API_ENABLED must be true or 1', () => {
  const warnings: string[] = [];
  const warn = (m: string) => void warnings.push(m);
  assert.equal(configFromEnv({}, warn).enabled, false);
  assert.equal(configFromEnv({ API_ENABLED: 'true', API_KEYS: '' }, warn).enabled, true);
  assert.equal(configFromEnv({ API_ENABLED: '1' }, warn).enabled, true);
  assert.equal(configFromEnv({ API_ENABLED: 'yes' }, warn).enabled, false);
  assert.ok(warnings.some((w) => /API_ENABLED is "yes"/.test(w)));
  assert.ok(warnings.some((w) => /API_KEYS has no keys/.test(w)));
});

test('405 for anything but GET, with Allow', async () => {
  const s = await serve();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await s.get('/seasons', { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
      assert.equal((await res.json()).error.code, 'method_not_allowed');
    }
    assert.equal((await s.get('/seasons', { method: 'HEAD' })).status, 200);
  } finally {
    await s.close();
  }
});

test('404 for a route that does not exist, in the error envelope', async () => {
  const s = await serve();
  try {
    for (const path of ['/nope', '/seasons/5', '/']) {
      const res = await s.get(path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'No such route.' } });
    }
  } finally {
    await s.close();
  }
});

test('400 for a parameter the route does not take', async () => {
  const s = await serve();
  try {
    const res = await s.get('/seasons?season=5');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: { code: 'bad_request', message: 'Unknown parameter season. This route takes none.' },
    });
  } finally {
    await s.close();
  }
});

test('a matching If-None-Match returns 304', async () => {
  const s = await serve();
  try {
    const first = await s.get('/seasons');
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^"[\w-]{32}"$/);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const again = await s.get('/seasons', { headers: { 'if-none-match': header } });
      assert.equal(again.status, 304, header);
      assert.equal(again.headers.get('etag'), etag);
      assert.equal(await again.text(), '');
    }
    assert.equal((await s.get('/seasons', { headers: { 'if-none-match': '"other"' } })).status, 200);
  } finally {
    await s.close();
  }
});

test('the ETag holds across refreshes that change nothing, and moves when the data does', async () => {
  const s = await serve();
  try {
    const etag = (await s.get('/seasons')).headers.get('etag')!;
    s.refresher.snapshot = { value: buildResources(fixtureLeague()), asOf: '2026-11-27T12:01:00.000Z' };
    const same = await s.get('/seasons', { headers: { 'if-none-match': etag } });
    assert.equal(same.status, 304, 'only as_of moved');

    const l = fixtureLeague();
    l.seasons[0].active = 'FALSE';
    s.refresher.snapshot = { value: buildResources(l), asOf: '2026-11-27T12:02:00.000Z' };
    const changed = await s.get('/seasons', { headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
  } finally {
    await s.close();
  }
});

test('the access log never shows a Discord ID from a path', () => {
  assert.equal(loggedPath('/api/v1/trainers/by-discord/1100000000000000001'), '/api/v1/trainers/by-discord/:discord_id');
  assert.equal(loggedPath('/api/v1/trainers/by-discord/1100000000000000001?x=1'), '/api/v1/trainers/by-discord/:discord_id?x=1');
  assert.equal(loggedPath('/api/v1/seasons'), '/api/v1/seasons');
});

test('no response contains a Discord ID', async () => {
  const s = await serve();
  try {
    for (const path of ['/seasons']) {
      const body = await (await s.get(path)).text();
      assert.doesNotMatch(body, DISCORD_ID, path);
    }
    // The fixture does hold Discord IDs, so the scan can find them.
    assert.match(JSON.stringify(fixtureLeague().trainers), DISCORD_ID);
  } finally {
    await s.close();
  }
});
