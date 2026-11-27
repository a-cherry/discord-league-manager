// The in-memory copy of the League DB the API serves. One readTabs call over
// the 8 tabs the endpoints need, every 60 seconds, on one timer chain (as in
// src/jobs/runner.ts, not an interval) so a slow read can't stack up behind the
// next. A read that fails, including a header row that doesn't match
// src/schema.ts, keeps the last good snapshot; meta.as_of shows its age.
import type { Timer } from '../jobs/runner.js';
import { readTabs, type Row, type SheetRow } from '../sheet-rows.js';

export const SNAPSHOT_TABS = ['gyms', 'trainers', 'decks', 'seasons', 'divisions', 'matches', 'matchRosters', 'games'] as const;
type SnapshotTab = (typeof SNAPSHOT_TABS)[number];

// The tabs' rows, without sheet row numbers.
export type League = { [K in SnapshotTab]: Row<K>[] };

// What readTabs(...SNAPSHOT_TABS) returns, in the same order.
type Tabs = readonly [
  SheetRow<'gyms'>[], SheetRow<'trainers'>[], SheetRow<'decks'>[], SheetRow<'seasons'>[],
  SheetRow<'divisions'>[], SheetRow<'matches'>[], SheetRow<'matchRosters'>[], SheetRow<'games'>[],
];

// Only complete matches are served. save.ts marks a match pending while it
// rewrites the games, so a match being corrected drops out until it's complete
// again; its games and rosters drop out with it. The previous version is not
// carried forward.
export function fromTabs([gyms, trainers, decks, seasons, divisions, matches, matchRosters, games]: Tabs): League {
  const values = <K extends SnapshotTab>(rows: SheetRow<K>[]) => rows.map((r) => r.values);
  const complete = values(matches).filter((m) => m.status === 'complete');
  const ids = new Set(complete.map((m) => m.match_id));
  return {
    gyms: values(gyms),
    trainers: values(trainers),
    decks: values(decks),
    seasons: values(seasons),
    divisions: values(divisions),
    matches: complete,
    matchRosters: values(matchRosters).filter((r) => ids.has(r.match_id)),
    games: values(games).filter((g) => ids.has(g.match_id)),
  };
}

export const readLeague = async (): Promise<League> => fromTabs(await readTabs(...SNAPSHOT_TABS));

export const REFRESH_MS = 60_000;
// Failed reads in a row before staff are told: 10 minutes at one a minute, so
// a short Sheets hiccup never alerts.
export const ALERT_AFTER_FAILURES = 10;

export interface Snapshot<T> {
  value: T;
  // When the read that produced it started: the data is at least this new.
  asOf: string;
}

export interface RefresherDeps<T> {
  // One read, built into what the routes serve. Throws when it fails.
  read(): Promise<T>;
  now(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
  log(message: string): void;
  // Once per outage: when the failures in a row reach ALERT_AFTER_FAILURES,
  // and when a read next succeeds after that. Never repeated in between.
  onOutage?(err: unknown, failures: number, servingAsOf: string | undefined): Promise<void>;
  onRecovery?(failures: number): Promise<void>;
}

export interface Refresher<T> {
  // The last good snapshot. Undefined before the first read succeeds and after stop().
  current(): Snapshot<T> | undefined;
  // Reads now, or joins the read already in progress.
  refresh(): Promise<void>;
  // Stops the timer and resolves once a read in progress has finished.
  stop(): Promise<void>;
}

export const describe = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export function startRefresher<T>(deps: RefresherDeps<T>, intervalMs = REFRESH_MS, alertAfter = ALERT_AFTER_FAILURES): Refresher<T> {
  let stopped = false;
  let timer: Timer | undefined;
  let inFlight: Promise<void> | undefined;
  let snapshot: Snapshot<T> | undefined;
  let failures = 0;

  // An alert that fails to post is logged; it never stops the refresh.
  const notify = (what: string, send: (() => Promise<void>) | undefined) =>
    void send?.().catch((err) => deps.log(`could not post the ${what} alert: ${describe(err)}`));

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve();
    const started = deps.now();
    inFlight = (async () => {
      try {
        const value = await deps.read();
        if (stopped) return;
        snapshot = { value, asOf: started.toISOString() };
        if (failures) deps.log(`read succeeded after ${failures} failed read(s)`);
        if (failures >= alertAfter) notify('recovery', deps.onRecovery && (() => deps.onRecovery!(failures)));
        failures = 0;
      } catch (err) {
        failures++;
        deps.log(`read failed (${failures} in a row); serving the snapshot from ${snapshot?.asOf ?? 'nowhere: none loaded yet'}: ${describe(err)}`);
        if (failures === alertAfter) notify('outage', deps.onOutage && (() => deps.onOutage!(err, failures, snapshot?.asOf)));
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  // The next read is armed when this one ends, so two can never overlap.
  const arm = () => {
    if (stopped) return;
    timer = deps.setTimeout(() => void refresh().then(arm), intervalMs);
  };

  void refresh().then(arm);

  return {
    current: () => (stopped ? undefined : snapshot),
    refresh,
    async stop() {
      stopped = true;
      timer?.clear();
      await inFlight;
    },
  };
}

// Real timers, unref'd so a waiting refresh never holds the process open.
export const liveTimer = (fn: () => void, ms: number): Timer => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { clear: () => clearTimeout(t) };
};
