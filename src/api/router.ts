// The read-only API for PokeTracker, mounted at /api/v1 by src/server.ts. Every
// route is a GET served from the in-memory snapshot (snapshot.ts), in the
// envelope { data, meta: { as_of, count } }. Spec: docs/pktr-api.md.
import { Router, type Request, type Response } from 'express';
import { parseKeys, requireKey, type ApiKey } from './auth.js';
import { BadParameter, sendError } from './errors.js';
import { etagOf, matchesEtag } from './etag.js';
import { buildResources, type Resources } from './map/index.js';
import { liveTimer, readLeague, startRefresher, type Refresher } from './snapshot.js';

export interface ApiConfig {
  // API_ENABLED. Off, the router passes every request on as if it weren't mounted.
  enabled: boolean;
  feedKeys: ApiKey[]; // API_KEYS: the list routes
  lookupKeys: ApiKey[]; // API_LOOKUP_KEYS: /trainers/by-discord only
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, warn = (m: string) => console.error(`api: ${m}`)): ApiConfig {
  const flag = (env.API_ENABLED ?? '').trim().toLowerCase();
  const enabled = flag === 'true' || flag === '1';
  if (flag && !enabled) warn(`API_ENABLED is "${env.API_ENABLED}", not true or 1; the API is off`);
  const config = {
    enabled,
    feedKeys: parseKeys(env.API_KEYS, (m) => warn(`API_KEYS: ${m}`)),
    lookupKeys: parseKeys(env.API_LOOKUP_KEYS, (m) => warn(`API_LOOKUP_KEYS: ${m}`)),
  };
  if (enabled && !config.feedKeys.length) warn('API_KEYS has no keys; every list request will get 401');
  return config;
}

export interface ApiDeps {
  startRefresher(): Refresher<Resources>;
  log(message: string): void;
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

interface ListRoute {
  path: string;
  params: readonly string[];
  list(resources: Resources, query: Query): unknown[];
}

const LIST_ROUTES: ListRoute[] = [
  { path: '/seasons', params: [], list: (r) => r.seasons },
];

// The access log never shows a Discord ID: the lookup's path is logged without it.
export const loggedPath = (url: string) => url.replace(/\/by-discord\/[^/?]*/, '/by-discord/:discord_id');

export function createApi(config: ApiConfig, deps: ApiDeps): Api {
  let refresher: Refresher<Resources> | undefined;
  let stopping = false;
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

  const serveList = (route: ListRoute) => (req: Request, res: Response) => {
    const snapshot = refresher?.current();
    if (!snapshot) {
      sendError(res, 'not_ready', 'Starting; try again shortly.');
      return;
    }
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
    router.all(route.path, (_req, res) => {
      res.set('Allow', 'GET, HEAD');
      sendError(res, 'method_not_allowed', 'This API is read-only: GET only.');
    });
  }

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
      refresher = deps.startRefresher();
    },
    async stop() {
      stopping = true;
      await refresher?.stop();
    },
  };
}

// The API as the bot runs it: config from the environment, the League DB read
// through readTabs on real timers.
export function liveApi(): Api {
  const log = (message: string) => console.log(`api: ${message}`);
  return createApi(configFromEnv(), {
    log,
    startRefresher: () =>
      startRefresher({
        read: async () => buildResources(await readLeague()),
        now: () => new Date(),
        setTimeout: liveTimer,
        log: (message) => log(`snapshot: ${message}`),
      }),
  });
}
