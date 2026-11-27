// Everything the routes serve, built once per refresh rather than per request.
// Two kinds of bad cell, handled differently:
// - Structural (a score, week, season or date that doesn't read): the refresh
//   fails and the last good snapshot stays, since serving it would show wrong results.
// - Cosmetic (a country that isn't a country code, two Decks rows for one
//   deck): served degraded and reported through `warn`, so one cell can't
//   freeze match results.
import { trainerIds } from '../ids.js';
import type { League } from '../snapshot.js';
import { mapDecks, type DeckResource } from './deck.js';
import { mapGyms, type GymResource } from './gym.js';
import { mapMatches, type MatchResource } from './matches.js';
import { mapSeasons, type SeasonResource } from './season.js';
import { mapTrainers, memberships, type Membership, type TrainerResource } from './trainer.js';

export interface Resources {
  seasons: SeasonResource[];
  matches: MatchResource[];
  gyms: GymResource[];
  trainers: TrainerResource[];
  decks: DeckResource[];
  // Discord ID to membership. Internal: only the lookup reads it, and it never
  // goes into a response as is.
  members: Map<string, Membership>;
}

export interface BuildOptions {
  idSecret: string; // API_ID_SECRET
  logoBaseUrl: string; // API_LOGO_BASE_URL
}

export function buildResources(league: League, { idSecret, logoBaseUrl }: BuildOptions, warn: (message: string) => void = () => {}): Resources {
  const ids = trainerIds(idSecret);
  return {
    seasons: mapSeasons(league.seasons),
    matches: mapMatches(league, ids),
    gyms: mapGyms(league.gyms, league.divisions, league.seasons, logoBaseUrl),
    trainers: mapTrainers(league.trainers, ids, warn),
    decks: mapDecks(league.decks, warn),
    members: memberships(league.trainers, ids),
  };
}

// Logs a refresh's warnings only when they change: a cell that stays wrong is
// logged once, not every minute, and its fix is logged too.
export function warningLog(log: (message: string) => void) {
  let last = new Set<string>();
  return (warnings: string[]) => {
    const now = new Set(warnings);
    for (const w of now) if (!last.has(w)) log(`warning: ${w}`);
    for (const w of last) if (!now.has(w)) log(`fixed: ${w}`);
    last = now;
  };
}
