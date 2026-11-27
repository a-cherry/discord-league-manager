// The read-only API for PokeTracker (PKTR), mounted at /api/v1 by src/server.ts.
// Five lists (seasons, matches, gyms, trainers, decks) on one key, and the
// Discord ID lookup on another. Every route is a GET served from the in-memory
// snapshot (snapshot.ts), in the envelope { data, meta: { as_of, count } }. No
// response ever contains a Discord ID.
import { Router, type Request, type Response } from 'express';
import { postMessage } from '../discord.js';
import { STAGES } from '../match/validate.js';
import { LOOKUP_LIMIT, LOOKUP_WINDOW_MS, parseKeys, rateLimit, RateLimiter, requireKey, type ApiKey } from './auth.js';
import { BadParameter, sendError } from './errors.js';
import { etagOf, matchesEtag } from './etag.js';
import { trainerIds } from './ids.js';
import { GYM_STATUSES } from './map/gym.js';
import { buildResources, warningLog, type Resources } from './map/index.js';
import { TRAINER_STATUSES } from './map/trainer.js';
import { describe, liveTimer, readLeague, startRefresher, type Refresher } from './snapshot.js';

export interface ApiConfig {
  // API_ENABLED. Off, the router passes every request on as if it weren't mounted.
  enabled: boolean;
  feedKeys: ApiKey[]; // API_KEYS: the list routes
  lookupKeys: ApiKey[]; // API_LOOKUP_KEYS: /trainers/by-discord only
  idSecret: string; // API_ID_SECRET
  logoBaseUrl: string; // API_LOGO_BASE_URL
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, warn = (m: string) => console.error(`api: ${m}`)): ApiConfig {
  const flag = (env.API_ENABLED ?? '').trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  if (flag && !enabled) warn(`API_ENABLED is "${env.API_ENABLED}", not true or 1; the API is off`);
  const config = {
    enabled,
    feedKeys: parseKeys(env.API_KEYS, (m) => warn(`API_KEYS: ${m}`)),
    lookupKeys: parseKeys(env.API_LOOKUP_KEYS, (m) => warn(`API_LOOKUP_KEYS: ${m}`)),
    idSecret: env.API_ID_SECRET?.trim() ?? '',
    logoBaseUrl: env.API_LOGO_BASE_URL?.trim() ?? '',
  };
  if (enabled && !config.feedKeys.length) warn('API_KEYS has no keys; every list request will get 401');
  if (enabled && !config.lookupKeys.length) warn('API_LOOKUP_KEYS has no keys; every lookup will get 401');
  return config;
}

// The settings the API can't run without. Missing any, it stays at 503 and says why in the log.
export const missingSettings = (config: ApiConfig) =>
  [!config.idSecret && 'API_ID_SECRET', !config.logoBaseUrl && 'API_LOGO_BASE_URL'].filter((s): s is string => Boolean(s));

export interface ApiDeps {
  startRefresher(): Refresher<Resources>;
  log(message: string): void;
  now?: () => number;
}

export interface Api {
  router: Router;
  // Starts the snapshot refresh. Called once startup has finished; until the
  // first read lands, every route answers 503.
  start(): void;
  // Stops it for a shutdown. From the call on, every route answers 503.
  stop(): Promise<void>;
}

type Query = Record<string, string>;

// The query parameters a route takes. Anything else is a 400, so a typo or a
// filter a route doesn't have (season on /gyms) fails loudly instead of being ignored.
function readQuery(req: Request, allowed: readonly string[]): Query {
  const query: Query = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (!allowed.includes(name)) {
      throw new BadParameter(allowed.length ? `Unknown parameter ${name}. This route takes ${allowed.join(', ')}.` : `Unknown parameter ${name}. This route takes none.`);
    }
    if (typeof value !== 'string') throw new BadParameter(`Give ${name} once.`);
    query[name] = value;
  }
  return query;
}

// Filter values. Each is undefined when the parameter wasn't given.
function wholeNumberParam(query: Query, name: string): number | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new BadParameter(`${name} must be a whole number.`);
  return Number(value);
}

function oneOfParam(query: Query, name: string, values: readonly string[]): string | undefined {
  const value = query[name];
  if (value === undefined || values.includes(value)) return value;
  throw new BadParameter(`${name} must be one of ${values.join(', ')}.`);
}

function gymParam(query: Query, resources: Resources): string | undefined {
  const value = query.gym_id;
  if (value === undefined || resources.gyms.some((g) => g.id === value)) return value;
  throw new BadParameter(`No gym ${value}. Gym ids are as in /gyms.`);
}

interface ListRoute {
  path: string;
  params: readonly string[];
  list(resources: Resources, query: Query): unknown[];
}

const LIST_ROUTES: ListRoute[] = [
  { path: '/seasons', params: [], list: (r) => r.seasons },
  {
    path: '/matches',
    params: ['season', 'stage', 'week', 'gym_id'],
    list: (r, q) => {
      const season = wholeNumberParam(q, 'season');
      const stage = oneOfParam(q, 'stage', STAGES);
      const week = wholeNumberParam(q, 'week');
      const gym = gymParam(q, r);
      return r.matches.filter(
        (m) =>
          (season === undefined || m.season === season) &&
          (stage === undefined || m.stage === stage) &&
          (week === undefined || m.week === week) &&
          (gym === undefined || m.left_gym_id === gym || m.right_gym_id === gym),
      );
    },
  },
  {
    path: '/gyms',
    params: ['status'],
    list: (r, q) => {
      const status = oneOfParam(q, 'status', GYM_STATUSES);
      return r.gyms.filter((g) => status === undefined || g.status === status);
    },
  },
  {
    path: '/trainers',
    params: ['gym_id', 'status'],
    list: (r, q) => {
      const gym = gymParam(q, r);
      const status = oneOfParam(q, 'status', TRAINER_STATUSES);
      return r.trainers.filter((t) => (gym === undefined || t.gym_id === gym) && (status === undefined || t.status === status));
    },
  },
  { path: '/decks', params: [], list: (r) => r.decks },
];

export const LOOKUP_PATH = '/trainers/by-discord/:discord_id';

// The access log never shows a Discord ID: the lookup's path is logged without it.
export const loggedPath = (url: string) => url.replace(/\/by-discord\/[^/?]*/, '/by-discord/:discord_id');

const methodNotAllowed = (_req: Request, res: Response) => {
  res.set('Allow', 'GET, HEAD');
  sendError(res, 'method_not_allowed', 'This API is read-only: GET only.');
};

export function createApi(config: ApiConfig, deps: ApiDeps): Api {
  let refresher: Refresher<Resources> | undefined;
  let stopping = false;
  const missing = missingSettings(config);
  const ids = trainerIds(config.idSecret);
  const limiter = new RateLimiter(LOOKUP_LIMIT, LOOKUP_WINDOW_MS, deps.now);
  const router = Router();

  router.use((req, res, next) => {
    if (!config.enabled) {
      next('router');
      return;
    }
    const started = Date.now();
    res.on('finish', () => {
      const label = (res.locals.keyLabel as string | undefined) ?? '-';
      deps.log(`${req.method} ${loggedPath(req.originalUrl)} ${res.statusCode} ${label} ${Date.now() - started}ms`);
    });
    // Starting, stopping for a deploy, or the first read hasn't landed: as /health does.
    if (!refresher?.current()) {
      res.set('Retry-After', '10');
      sendError(res, 'not_ready', stopping ? 'Shutting down; try again shortly.' : 'Starting; try again shortly.');
      return;
    }
    next();
  });

  // Each handler runs after the check above, so a snapshot is there.
  const snapshotOf = () => refresher!.current()!;

  const serveList = (route: ListRoute) => (req: Request, res: Response) => {
    const snapshot = snapshotOf();
    let data: unknown[];
    try {
      data = route.list(snapshot.value, readQuery(req, route.params));
    } catch (err) {
      if (!(err instanceof BadParameter)) throw err;
      sendError(res, 'bad_request', err.message);
      return;
    }
    const etag = etagOf(data);
    res.set('ETag', etag);
    // PKTR may keep a copy but must check it each time; the ETag makes that a 304.
    res.set('Cache-Control', 'private, no-cache');
    if (matchesEtag(req.get('if-none-match'), etag)) {
      res.status(304).end();
      return;
    }
    res.json({ data, meta: { as_of: snapshot.asOf, count: data.length } });
  };

  for (const route of LIST_ROUTES) {
    router.get(route.path, requireKey(config.feedKeys), serveList(route));
    router.all(route.path, methodNotAllowed);
  }

  // The one route that takes a Discord ID, and none returns one. Its own key,
  // 60 an hour. Logged by opaque id, hit or miss, never by Discord ID, so the
  // log doesn't become the mapping the opaque ids exist to avoid.
  router.get(LOOKUP_PATH, requireKey(config.lookupKeys), rateLimit(limiter), (req, res) => {
    const snapshot = snapshotOf();
    try {
      readQuery(req, []);
    } catch (err) {
      sendError(res, 'bad_request', (err as Error).message);
      return;
    }
    const discordId = String(req.params.discord_id);
    if (!/^\d{17,20}$/.test(discordId)) {
      sendError(res, 'bad_request', 'That is not a Discord ID.');
      return;
    }
    const member = snapshot.value.members.get(discordId);
    deps.log(`lookup ${new Date(deps.now?.() ?? Date.now()).toISOString()} ${res.locals.keyLabel} ${member ? 'hit' : 'miss'} ${member?.trainer_id ?? ids(discordId)}`);
    res.set('Cache-Control', 'private, no-cache');
    if (!member) {
      sendError(res, 'not_found', 'Not a league member.');
      return;
    }
    res.json({ data: member, meta: { as_of: snapshot.asOf } });
  });
  router.all(LOOKUP_PATH, methodNotAllowed);

  router.use((_req, res) => sendError(res, 'not_found', 'No such route.'));

  // Express 5 sends a thrown error here. The message stays in the log, not the response.
  router.use((err: unknown, _req: Request, res: Response, _next: () => void) => {
    deps.log(`request failed: ${err instanceof Error ? err.stack : String(err)}`);
    if (!res.headersSent) sendError(res, 'internal', 'Something went wrong on our side.');
  });

  return {
    router,
    start() {
      if (!config.enabled || refresher || stopping) return;
      if (missing.length) {
        deps.log(`not started: ${missing.join(' and ')} not set; every request gets 503`);
        return;
      }
      refresher = deps.startRefresher();
    },
    async stop() {
      stopping = true;
      await refresher?.stop();
    },
  };
}

// The staff alerts for an outage, posted to #bot-staff without pinging anyone:
// PKTR showing old data is worth knowing about, not worth waking someone for.
// Match submissions and roster commands read the League DB themselves, so they
// fail or work on their own; only the API's copy is stuck.
export const outageAlert = (err: unknown, failures: number, servingAsOf: string | undefined) =>
  `**PKTR API**: the bot hasn't been able to read the League DB for ${failures} minutes, so PokeTracker is ` +
  (servingAsOf ? `showing data from ${servingAsOf}` : 'getting 503s (no data loaded since the bot started)') +
  `. Last error: ${describe(err)} This is the only alert until it recovers.`;

export const recoveryAlert = (failures: number) =>
  `**PKTR API**: reading the League DB again after ${failures} failed reads (about ${failures} minutes); PokeTracker has current data.`;

// The API as the bot runs it: config from the environment, the League DB read
// through readTabs on real timers, outage alerts to the staff channel.
export function liveApi(): Api {
  const log = (message: string) => console.log(`api: ${message}`);
  const config = configFromEnv();
  const logWarnings = warningLog((message) => log(`snapshot: ${message}`));
  return createApi(config, {
    log,
    startRefresher: () =>
      startRefresher({
        read: async () => {
          const warnings: string[] = [];
          const resources = buildResources(await readLeague(), config, (w) => void warnings.push(w));
          logWarnings(warnings);
          return resources;
        },
        now: () => new Date(),
        setTimeout: liveTimer,
        log: (message) => log(`snapshot: ${message}`),
        onOutage: (err, failures, asOf) => postStaffChannel(outageAlert(err, failures, asOf)),
        onRecovery: (failures) => postStaffChannel(recoveryAlert(failures)),
      }),
  });
}

async function postStaffChannel(text: string): Promise<void> {
  const channelId = process.env.DISCORD_STAFF_CHANNEL_ID;
  if (!channelId) throw new Error('DISCORD_STAFF_CHANNEL_ID is not set');
  await postMessage(channelId, text);
}
