 // Match tab parsing. Pure: no Sheets or Discord imports.

// The three blocks of a match tab the bot reads, in one batchGet with
// FORMATTED_VALUE. Cell addresses are fixed anchors on the S5 template (see
// the Sheet contract in the Match Ingestion Implementation Plan); a layout
// edit to the template must update these and the sentinel check.
//   AK1:AP13  gym_id helper (AK1:AL2), season/stage/week (AM1:AO2),
//             name to Discord ID table (AO3:AP13)
//   C17:S19   roster headers (C17 merged to J17, N17 merged to U17) and roster slots (rows 18 and 19)
//   C21:R41   game rows 21 to 39 and the reported score (K41, M41)
export const MATCH_RANGES = ['AK1:AP13', 'C17:S19', 'C21:R41'] as const;

export type MatchRange = (typeof MATCH_RANGES)[number];

// A match tab as the parser sees it: A1 address to formatted value. Empty
// cells are left out, so a missing key and '' both mean blank.
export type MatchCells = Record<string, string>;

export function columnNumber(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

export function columnName(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Flattens batchGet results (one 2D array per range, in MATCH_RANGES order,
// with trailing empty rows and cells left out) into a cell map.
export function cellsFromRanges(values: readonly (readonly (readonly string[])[])[]): MatchCells {
  const cells: MatchCells = {};
  MATCH_RANGES.forEach((range, i) => {
    const [, col, row] = /^([A-Z]+)(\d+):/.exec(range)!;
    const [c0, r0] = [columnNumber(col), Number(row)];
    (values[i] ?? []).forEach((cols, r) =>
      cols.forEach((v, c) => {
        if (v !== '') cells[`${columnName(c0 + c)}${r0 + r}`] = String(v);
      }),
    );
  });
  return cells;
}

// ---- Layout -----------------------------------------------------------------

export const SIDES = ['left', 'right'] as const;
export type Side = (typeof SIDES)[number];

// A tab is a match tab with an intact layout only if these cells read so.
export const SENTINELS: Record<string, string> = {
  AK1: 'Left gym_id', AL1: 'Right gym_id', AM1: 'Season', AN1: 'Stage', AO1: 'Week',
  AO3: 'Player', AP3: 'discord_id', C17: 'ROSTER', N17: 'ROSTER',
};

// Roster slot cells in slot order, and each slot's row in the name to
// Discord ID table AO4:AP13 (left slots in rows 4 to 8, right in 9 to 13).
export const ROSTER_SLOTS: Record<Side, readonly string[]> = {
  left: ['C18', 'F18', 'H18', 'C19', 'G19'],
  right: ['N18', 'Q18', 'S18', 'N19', 'R19'],
};
const TABLE_FIRST_ROW: Record<Side, number> = { left: 4, right: 9 };

export const FIRST_GAME_ROW = 21;
export const LAST_GAME_ROW = 39;
export const GAME_COLUMNS = {
  trainerLeft: 'C', deckLeft: 'G', resultLeft: 'K', resultRight: 'M', deckRight: 'N', trainerRight: 'R',
} as const;
export type GameField = keyof typeof GAME_COLUMNS;
export const GAME_FIELDS = Object.keys(GAME_COLUMNS) as GameField[];

// ---- Normalizing ------------------------------------------------------------

// Trims and collapses runs of whitespace, newlines included.
export const clean = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

// Error values arrive as text with FORMATTED_VALUE.
const ERROR_VALUES = new Set(['#N/A', '#REF!', '#VALUE!', '#NAME?', '#DIV/0!', '#NUM!', '#NULL!', '#ERROR!', '#SPILL!', '#CALC!', 'Loading...']);
export const isErrorValue = (value: string) => ERROR_VALUES.has(value);

// Deck names compare ignoring case and spacing. Reversed names stay different.
export const deckKey = (name: string) => name.toLowerCase().replace(/\s+/g, '');

// Matches typed deck names against the Decks tab: resolve() gives the stored
// spelling, or the name as typed for a new deck; added lists the new decks in
// the order first seen. Used by validation (the New deck warnings) and by the
// save (against Decks as re-read inside the lock), so both agree.
export function deckMatcher(existing: readonly string[]) {
  const known = new Map(existing.map((name) => [deckKey(name), name]));
  const added: string[] = [];
  const resolve = (typed: string) => {
    const key = deckKey(typed);
    if (!known.has(key)) {
      known.set(key, typed);
      added.push(typed);
    }
    return known.get(key)!;
  };
  return { resolve, added };
}

export type ResultKind = 'W' | 'L' | 'TIE' | 'DQW' | 'DQL';
export type DqReason = 'W' | 'R';
export interface Result {
  kind: ResultKind;
  reason?: DqReason;
}

// The nine values of the result dropdown on K21:K39 and M21:M39. Read
// case-insensitively after clean(); no other spelling is accepted.
const RESULTS: Record<string, Result> = {
  W: { kind: 'W' },
  L: { kind: 'L' },
  TIE: { kind: 'TIE' },
  DQW: { kind: 'DQW' },
  DQL: { kind: 'DQL' },
  'DQW (W)': { kind: 'DQW', reason: 'W' },
  'DQL (W)': { kind: 'DQL', reason: 'W' },
  'DQW (R)': { kind: 'DQW', reason: 'R' },
  'DQL (R)': { kind: 'DQL', reason: 'R' },
};

export const parseResult = (value: string): Result | undefined => RESULTS[clean(value).toUpperCase()];

// A side scores a point for each opposing deck it eliminates: a win of any
// kind, or a tie, which eliminates one deck on each side.
export const scoresPoint = (r: Result) => r.kind === 'W' || r.kind === 'DQW' || r.kind === 'TIE';
// For the sequence rules a tie and every DQL are losses.
export const isSequenceLoss = (r: Result) => r.kind === 'L' || r.kind === 'TIE' || r.kind === 'DQL';

// W/L, L/W, TIE/TIE, or a DQW with a DQL carrying the same reason code.
export function resultsPair(left: Result, right: Result): boolean {
  const kinds = `${left.kind}/${right.kind}`;
  if (kinds === 'W/L' || kinds === 'L/W' || kinds === 'TIE/TIE') return true;
  if (kinds === 'DQW/DQL' || kinds === 'DQL/DQW') return left.reason === right.reason;
  return false;
}

// ---- Parsing ----------------------------------------------------------------

export interface RosterSlot {
  side: Side;
  slot: number; // 1 to 5
  cell: string;
  name: string; // the roster slot cell
  tableName: string; // AO on the slot's row
  discordId: string; // AP on the slot's row: an ID, blank, NOT FOUND or an error value
}

export type GameCells = Record<GameField, string>;
export interface GameRow extends GameCells {
  row: number; // sheet row
}

export interface ParsedMatch {
  tab: string;
  config: { season: string; stage: string; week: string };
  gymIds: Record<Side, string>;
  slots: Record<Side, RosterSlot[]>;
  games: GameRow[]; // rows with any game cell filled, in row order
  reported: Record<Side, string>; // K41, M41
}

// Sentinel cells that don't read as expected, as "AK1 reads x, expected y".
export function checkSentinels(cells: MatchCells): string[] {
  return Object.entries(SENTINELS)
    .filter(([a1, want]) => clean(cells[a1]) !== want)
    .map(([a1, want]) => `${a1} reads "${clean(cells[a1])}", expected "${want}"`);
}

// Cell map to ParsedMatch. Every value is clean()ed. Lenient: validate() does
// the checking, so nothing here fails.
export function parseMatch(tab: string, cells: MatchCells): ParsedMatch {
  const get = (a1: string) => clean(cells[a1]);
  const slots = Object.fromEntries(
    SIDES.map((side) => [
      side,
      ROSTER_SLOTS[side].map((cell, i) => {
        const row = TABLE_FIRST_ROW[side] + i;
        return { side, slot: i + 1, cell, name: get(cell), tableName: get(`AO${row}`), discordId: get(`AP${row}`) };
      }),
    ]),
  ) as Record<Side, RosterSlot[]>;

  const games: GameRow[] = [];
  for (let row = FIRST_GAME_ROW; row <= LAST_GAME_ROW; row++) {
    const game = Object.fromEntries(GAME_FIELDS.map((f) => [f, get(`${GAME_COLUMNS[f]}${row}`)])) as GameCells;
    if (GAME_FIELDS.some((f) => game[f] !== '')) games.push({ row, ...game });
  }

  return {
    tab,
    config: { season: get('AM2'), stage: get('AN2'), week: get('AO2') },
    gymIds: { left: get('AK2'), right: get('AL2') },
    slots,
    games,
    reported: { left: get('K41'), right: get('M41') },
  };
}
