// Gyms rows as the API serves them, with each gym's division by season. Pure:
// no Sheets or Discord imports.
import { activeSeason } from '../../seasons.js';
import type { Row, SheetRow } from '../../sheet-rows.js';
import { wholeNumber } from './season.js';

export interface GymResource {
  id: string;
  name: string;
  abbreviation: string | null;
  status: string;
  division: string | null; // in the active season
  divisions: { season: number; division: string }[];
  logo_url: string;
}

// The statuses the Gyms tab holds. A filter for anything else is a 400.
export const GYM_STATUSES = ['active', 'inactive', 'relegated'] as const;

export function mapGyms(
  gyms: Row<'gyms'>[], divisions: Row<'divisions'>[], seasons: Row<'seasons'>[], logoBaseUrl: string,
): GymResource[] {
  // activeSeason reads sheet rows; the row numbers only appear in its error message.
  const active = activeSeason(seasons.map((values, i): SheetRow<'seasons'> => ({ rowNumber: i + 2, values })));
  const base = logoBaseUrl.replace(/\/+$/, '');
  return gyms.map((g) => {
    const own = divisions
      .filter((d) => d.gym_id === g.gym_id)
      .map((d) => ({ season: wholeNumber(d.season, 'Divisions season'), division: d.division }))
      .sort((a, b) => a.season - b.season);
    return {
      id: g.gym_id,
      name: g.name,
      abbreviation: g.abbreviation || null,
      status: g.status,
      division: own.find((d) => d.season === active?.season)?.division ?? null,
      divisions: own,
      // Built unconditionally: a missing logo is a broken image PKTR handles.
      logo_url: `${base}/${g.gym_id}.png`,
    };
  });
}
