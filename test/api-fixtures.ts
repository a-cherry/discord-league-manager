// Shared pieces for the API tests: a League built from test/fixtures/league.json,
// a refresher whose snapshot the test sets, and the router on a real port.
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseKeys } from '../src/api/auth.js';
import { buildResources, type BuildOptions, type Resources } from '../src/api/map/index.js';
import { createApi, type Api, type ApiConfig } from '../src/api/router.js';
import type { League, Refresher, Snapshot } from '../src/api/snapshot.js';
import { parseMatch } from '../src/match/parse.js';
import { saveMatch } from '../src/match/save.js';
import { validate } from '../src/match/validate.js';
import { TABS, type TabKey } from '../src/schema.js';
import type { Row } from '../src/sheet-rows.js';
import { exampleMatch, league } from './fixtures.js';
import { FakeMatchStore } from './match-store-fake.js';

export const AS_OF = '2026-11-27T12:00:00.000Z';

export const SHEET_ID = '1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg';
export const TAB_GID = '481516234';
export const SAVED_AT = new Date('2026-11-22T18:04:11.482Z');

// The Example Match (19 games, Phoenix G022 9-10 Summit G025) saved the way
// /match submit saves it, into a fake store: the rows ingestion really writes.
const { tab, cells } = exampleMatch();
const checked = validate(parseMatch(tab, cells), league());
if (checked.errors.length) throw new Error(`the Example Match no longer validates: ${checked.errors.join('; ')}`);
const store = new FakeMatchStore(league());
await saveMatch(
  {
    plan: checked.plan!, spreadsheetId: SHEET_ID, gid: TAB_GID, submittedBy: '1300000000000000001',
    gyms: { left: { name: 'Phoenix', emote: '' }, right: { name: 'Summit', emote: '' } },
  },
  { store, rebuildViews: async () => {}, announce: async () => {}, now: () => SAVED_AT, log: () => {} },
);

// As readTabs gives them: every cell a string, typed values included.
const asRead = <K extends TabKey>(key: K, rows: Record<string, unknown>[]): Row<K>[] =>
  rows.map((v) => Object.fromEntries(TABS[key].columns.map((c) => [c, String(v[c] ?? '')])) as Row<K>);

// The fixture league as the snapshot holds it: league.json plus the saved
// Example Match, and divisions for two seasons.
export function fixtureLeague(): League {
  const l = league();
  const values = <T>(rows: { values: T }[]) => rows.map((r) => r.values);
  return {
    gyms: values(l.gyms),
    trainers: values(l.trainers),
    decks: asRead('decks', store.tabs.decks),
    seasons: values(l.seasons),
    divisions: [
      { season: '5', gym_id: 'G022', division: 'A' },
      { season: '4', gym_id: 'G022', division: 'B' },
      { season: '5', gym_id: 'G025', division: 'B' },
    ],
    matches: asRead('matches', store.tabs.matches),
    matchRosters: asRead('matchRosters', store.tabs.matchRosters),
    games: asRead('games', store.tabs.games),
  };
}

export const BUILD: BuildOptions = {
  idSecret: 'test-id-secret',
  logoBaseUrl: 'https://cdn.jsdelivr.net/gh/a-cherry/discord-league-manager@v1/assets/logos',
};

export const fixtureResources = (l = fixtureLeague()) => buildResources(l, BUILD);

export const FEED_KEY = 'feed-secret-1';
export const FEED_KEY_2 = 'feed-secret-2';
export const LOOKUP_KEY = 'lookup-secret';
const entry = (label: string, key: string) => `${label}:${createHash('sha256').update(key).digest('hex')}`;

export const testConfig = (v: Partial<ApiConfig> = {}): ApiConfig => ({
  enabled: true,
  feedKeys: parseKeys([entry('pktr', FEED_KEY), entry('pktr-2', FEED_KEY_2)].join(',')),
  lookupKeys: parseKeys(entry('pktr-lookup', LOOKUP_KEY)),
  ...BUILD,
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
  { config = testConfig(), resources = fixtureResources(), start = true, now }:
    { config?: ApiConfig; resources?: Resources | null; start?: boolean; now?: () => number } = {},
): Promise<Served> {
  const refresher = new FakeRefresher(resources ?? undefined);
  const logs: string[] = [];
  const api = createApi(config, { startRefresher: () => refresher, log: (m) => void logs.push(m), now });
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
