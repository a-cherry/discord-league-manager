// Complete matches as the API serves them: the Matches row, its rosters and its
// games. Pure: no Sheets or Discord imports.
import { deckKey } from '../../match/parse.js';
import { parseSheetLink } from '../../sheet-links.js';
import type { Row } from '../../sheet-rows.js';
import type { TrainerIds } from '../ids.js';
import { wholeNumber } from './season.js';

export interface GameSide {
  trainer_id: string | null;
  nickname: string | null;
  deck_id: string | null;
  deck: string | null;
  result: string;
}

export interface MatchResource {
  id: string;
  season: number;
  stage: string;
  week: number;
  left_gym_id: string;
  right_gym_id: string;
  score_left: number;
  score_right: number;
  updated_at: string;
  source: { spreadsheet_id: string; tab_gid: string } | null;
  rosters: { left: string[]; right: string[] };
  games: { number: number; left: GameSide; right: GameSide }[];
}

export interface MatchTabs {
  matches: Row<'matches'>[];
  matchRosters: Row<'matchRosters'>[];
  games: Row<'games'>[];
  trainers: Row<'trainers'>[];
}

const groupBy = <T>(rows: T[], key: (row: T) => string) => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
};

function source(tabLink: string): MatchResource['source'] {
  const { spreadsheetId, gid } = parseSheetLink(tabLink);
  return spreadsheetId && gid ? { spreadsheet_id: spreadsheetId, tab_gid: gid } : null;
}

// Expects complete matches only; snapshot.ts drops the rest.
export function mapMatches({ matches, matchRosters, games, trainers }: MatchTabs, ids: TrainerIds): MatchResource[] {
  const nicknames = new Map(trainers.map((t) => [t.discord_id, t.server_nickname]));
  const rostersOf = groupBy(matchRosters, (r) => r.match_id);
  const gamesOf = groupBy(games, (g) => g.match_id);

  // A // row has no Trainer: everything but the result is null.
  const side = (trainer: string, deck: string, result: string): GameSide =>
    trainer
      ? { trainer_id: ids(trainer), nickname: nicknames.get(trainer) ?? null, deck_id: deck ? deckKey(deck) : null, deck: deck || null, result }
      : { trainer_id: null, nickname: null, deck_id: null, deck: null, result };

  return matches.map((m) => {
    const roster = rostersOf.get(m.match_id) ?? [];
    // The sheet's roster slots are an unordered list of names: no slot numbers.
    const rosterOf = (gymId: string) => roster.filter((r) => r.gym_id === gymId).map((r) => ids(r.discord_id));
    return {
      id: m.match_id,
      season: wholeNumber(m.season, `${m.match_id} season`),
      stage: m.stage,
      week: wholeNumber(m.week, `${m.match_id} week`),
      left_gym_id: m.gym_left_id,
      right_gym_id: m.gym_right_id,
      score_left: wholeNumber(m.score_left, `${m.match_id} score_left`),
      score_right: wholeNumber(m.score_right, `${m.match_id} score_right`),
      updated_at: m.submitted_at,
      source: source(m.tab_link),
      rosters: { left: rosterOf(m.gym_left_id), right: rosterOf(m.gym_right_id) },
      games: (gamesOf.get(m.match_id) ?? [])
        .map((g) => ({ g, number: wholeNumber(g.game_number, `${m.match_id} game_number`) }))
        .sort((a, b) => a.number - b.number)
        .map(({ g, number }) => ({
          number,
          left: side(g.trainer_left, g.deck_left, g.result_left),
          right: side(g.trainer_right, g.deck_right, g.result_right),
        })),
    };
  });
}
