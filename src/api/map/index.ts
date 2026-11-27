// Everything the routes serve, built once per refresh rather than per request.
// A row that can't be mapped fails the refresh, so the last good snapshot stays.
import type { League } from '../snapshot.js';
import { mapSeasons, type SeasonResource } from './season.js';

export interface Resources {
  seasons: SeasonResource[];
}

export const buildResources = (league: League): Resources => ({
  seasons: mapSeasons(league.seasons),
});
