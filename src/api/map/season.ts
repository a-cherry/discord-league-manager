// Seasons rows as the API serves them. Pure: no Sheets or Discord imports.
import { sheetDate } from '../../seasons.js';
import type { Row } from '../../sheet-rows.js';

export interface SeasonResource {
  season: number;
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  active: boolean;
}

// A malformed number or date throws, which fails the whole refresh and keeps
// the last good snapshot: the API serves stored values or nothing, never a guess.
export function wholeNumber(value: string, what: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${what} is not a whole number: "${value}"`);
  return Number(value);
}

// Dates read as Sheets serial numbers (readTabs reads unformatted values), so
// sheetDate turns them back into the YYYY-MM-DD staff typed. Active reads as
// TRUE or FALSE; activeSeason() in src/seasons.ts reads it the same way.
export const mapSeason = (v: Row<'seasons'>): SeasonResource => ({
  season: wholeNumber(v.season, 'Seasons season'),
  start_date: sheetDate(v.start_date),
  end_date: sheetDate(v.end_date),
  active: v.active.toLowerCase() === 'true',
});

export const mapSeasons = (rows: Row<'seasons'>[]) => rows.map(mapSeason);
