import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bearerToken, findKey, LOOKUP_LIMIT, LOOKUP_WINDOW_MS, parseKeys, RateLimiter } from '../src/api/auth.js';
import { FEED_KEY, FEED_KEY_2, LOOKUP_KEY, serve, testConfig } from './api-fixtures.js';

const hex = (key: string) => createHash('sha256').update(key).digest('hex');

test('parseKeys reads label:sha256hex pairs and skips malformed ones without logging them', () => {
  const warnings: string[] = [];
  const keys = parseKeys(` pktr:${hex('a')}, broken-entry-with-a-secret , pktr-2:${hex('b').toUpperCase()},`, (m) => void warnings.push(m));
  assert.deepEqual(keys.map((k) => k.label), ['pktr', 'pktr-2']);
  assert.deepEqual(warnings, ['entry 2 is not label:sha256hex; skipped']);
  assert.ok(!warnings.join().includes('secret'));
  assert.deepEqual(parseKeys(undefined), []);
  assert.deepEqual(parseKeys(''), []);
});

test('findKey matches the SHA-256 of the presented key', () => {
  const keys = parseKeys(`one:${hex('k1')},two:${hex('k2')}`);
  assert.equal(findKey(keys, 'k2')?.label, 'two');
  assert.equal(findKey(keys, 'k3'), undefined);
  assert.equal(findKey(keys, hex('k1')), undefined, 'the stored hash is not itself a key');
});

test('bearerToken reads only an Authorization: Bearer header', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer abc'), 'abc');
  assert.equal(bearerToken('Basic abc'), undefined);
  assert.equal(bearerToken('Bearer'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test('the lookup limit: 60 in an hour, the 61st refused with how long to wait', () => {
  let now = 0;
  const limiter = new RateLimiter(LOOKUP_LIMIT, LOOKUP_WINDOW_MS, () => now);
  for (let i = 0; i < 60; i++) {
    assert.equal(limiter.take('pktr-lookup').ok, true, `request ${i + 1}`);
    now += 1000;
  }
  // 60 seconds in: the first request leaves the window at 3600s.
  assert.deepEqual(limiter.take('pktr-lookup'), { ok: false, retryAfterSeconds: 3540 });
  assert.equal(limiter.take('another-key').ok, true, 'counted per key');
  now = LOOKUP_WINDOW_MS;
  assert.equal(limiter.take('pktr-lookup').ok, true, 'the first request has left the window');
  assert.equal(limiter.take('pktr-lookup').ok, false, 'and only it');
});

test('a list without a key, or with an unknown key, gets 401', async () => {
  const s = await serve();
  try {
    for (const key of [null, 'not-a-key', LOOKUP_KEY]) {
      const res = await s.get('/seasons', { key });
      assert.equal(res.status, 401, `key ${key}`);
      assert.equal((await res.json()).error.code, 'unauthorized');
    }
    const basic = await s.get('/seasons', { key: null, headers: { authorization: `Basic ${FEED_KEY}` } });
    assert.equal(basic.status, 401);
  } finally {
    await s.close();
  }
});

test('either feed key is accepted, and the log names its label', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('/seasons', { key: FEED_KEY })).status, 200);
    assert.equal((await s.get('/seasons', { key: FEED_KEY_2 })).status, 200);
    assert.match(s.logs[0], /^GET \/api\/v1\/seasons 200 pktr \d+ms$/);
    assert.match(s.logs[1], / pktr-2 /);
    assert.ok(!s.logs.join().includes(FEED_KEY), 'the key itself is never logged');
  } finally {
    await s.close();
  }
});

test('a key in the query string is not read', async () => {
  const s = await serve();
  try {
    const res = await s.get(`/seasons?key=${FEED_KEY}`, { key: null });
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test('with no feed keys configured, nothing gets in', async () => {
  const s = await serve({ config: testConfig({ feedKeys: [] }) });
  try {
    assert.equal((await s.get('/seasons')).status, 401);
  } finally {
    await s.close();
  }
});
