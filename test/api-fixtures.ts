// Shared pieces for the API tests: a League built from test/fixtures/league.json,
// a refresher whose snapshot the test sets, and the router on a real port.
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseKeys } from '../src/api/auth.js';
import { buildResources, type Resources } from '../src/api/map/index.js';
import { createApi, type Api, type ApiConfig } from '../src/api/router.js';
import type { League, Refresher, Snapshot } from '../src/api/snapshot.js';
import { league } from './fixtures.js';

export const AS_OF = '2026-11-27T12:00:00.000Z';

// The fixture league as the snapshot holds it. league.json has no divisions,
// rosters or games yet; the mapper tests add the real 19-game match.
export function fixtureLeague(): League {
  const l = league();
  const values = <T>(rows: { values: T }[]) => rows.map((r) => r.values);
  return {
    gyms: values(l.gyms),
    trainers: values(l.trainers),
    decks: values(l.decks),
    seasons: values(l.seasons),
    divisions: [],
    matches: values(l.matches),
    matchRosters: [],
    games: [],
  };
}

export const FEED_KEY = 'feed-secret-1';
export const FEED_KEY_2 = 'feed-secret-2';
export const LOOKUP_KEY = 'lookup-secret';
const entry = (label: string, key: string) => `${label}:${createHash('sha256').update(key).digest('hex')}`;

export const testConfig = (v: Partial<ApiConfig> = {}): ApiConfig => ({
  enabled: true,
  feedKeys: parseKeys([entry('pktr', FEED_KEY), entry('pktr-2', FEED_KEY_2)].join(',')),
  lookupKeys: parseKeys(entry('pktr-lookup', LOOKUP_KEY)),
  ...v,
});

// A refresher that reads nothing: the test sets what it serves.
export class FakeRefresher implements Refresher<Resources> {
  snapshot: Snapshot<Resources> | undefined;
  stopped = false;
  constructor(resources?: Resources, asOf = AS_OF) {
    if (resources) this.snapshot = { value: resources, asOf };
  }
  current() {
    return this.stopped ? undefined : this.snapshot;
  }
  async refresh() {}
  async stop() {
    this.stopped = true;
  }
}

export interface Served {
  api: Api;
  refresher: FakeRefresher;
  logs: string[];
  get(path: string, init?: RequestInit & { key?: string | null }): Promise<globalThis.Response>;
  close(): Promise<void>;
}

// The router on its own express app at /api/v1, as server.ts mounts it.
// get() sends the first feed key unless `key` says otherwise (null: none).
export async function serve(
  { config = testConfig(), resources = buildResources(fixtureLeague()), start = true }:
    { config?: ApiConfig; resources?: Resources | null; start?: boolean } = {},
): Promise<Served> {
  const refresher = new FakeRefresher(resources ?? undefined);
  const logs: string[] = [];
  const api = createApi(config, { startRefresher: () => refresher, log: (m) => void logs.push(m) });
  if (start) api.start();
  const app = express();
  app.use('/api/v1', api.router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return {
    api,
    refresher,
    logs,
    get: (path, { key = FEED_KEY, headers, ...init } = {}) =>
      fetch(base + path, {
        ...init,
        headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...(headers as Record<string, string>) },
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Discord IDs are 17 to 19 digit snowflakes. No response may contain one.
export const DISCORD_ID = /(?<!\d)\d{17,19}(?!\d)/;
