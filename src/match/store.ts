// The League DB reads and writes a match save needs, behind one interface so
// tests can swap in an in-memory store. sheetsMatchStore is the real one.
import { deleteRows } from '../league-db.js';
import { appendRows, readTabs, updateColumns, updateRows, type RowInput, type SheetRow } from '../sheet-rows.js';
import type { LeagueSnapshot } from './validate.js';

// Read inside the lock, right before writing.
export interface SaveState {
  matches: SheetRow<'matches'>[];
  decks: SheetRow<'decks'>[];
  games: SheetRow<'games'>[];
  rosters: SheetRow<'matchRosters'>[];
}

export interface MatchStore {
  // The tabs validation needs. One read.
  snapshot(): Promise<LeagueSnapshot>;
  // Matches, Decks, Games and Match rosters. One read.
  readForSave(): Promise<SaveState>;
  // Step 1. Each deck marked active, written as a boolean.
  appendDecks(names: string[]): Promise<void>;
  // Step 2, new match. Returns the appended row's sheet row number.
  appendMatch(row: RowInput<'matches'>): Promise<number>;
  // Step 2, re-submit.
  setMatchStatus(rowNumber: number, status: 'pending' | 'complete'): Promise<void>;
  // Step 3. Sheet row numbers from readForSave, both tabs in one call.
  deleteMatchRows(rows: { games: number[]; rosters: number[] }): Promise<void>;
  // Steps 4 and 5.
  appendRosters(rows: RowInput<'matchRosters'>[]): Promise<void>;
  appendGames(rows: RowInput<'games'>[]): Promise<void>;
  // Step 6: the whole row, status complete included, in one write.
  finalizeMatch(rowNumber: number, row: RowInput<'matches'>): Promise<void>;
}

export const sheetsMatchStore: MatchStore = {
  async snapshot() {
    const [gyms, trainers, seasons, matches, decks] = await readTabs('gyms', 'trainers', 'seasons', 'matches', 'decks');
    return { gyms, trainers, seasons, matches, decks };
  },
  async readForSave() {
    const [matches, decks, games, rosters] = await readTabs('matches', 'decks', 'games', 'matchRosters');
    return { matches, decks, games, rosters };
  },
  async appendDecks(names) {
    // A JSON boolean with RAW, so the Reference's Decks query (Col2 = TRUE)
    // sees a boolean, and a name starting with = stays text.
    await appendRows('decks', names.map((name) => ({ name, active: true })));
  },
  async appendMatch(row) {
    const rowNumber = await appendRows('matches', [row]);
    if (rowNumber === undefined) throw new Error(`Appending ${row.match_id} to Matches returned no row number`);
    return rowNumber;
  },
  async setMatchStatus(rowNumber, status) {
    await updateColumns('matches', ['status'], [{ rowNumber, values: { status } as SheetRow<'matches'>['values'] }]);
  },
  async deleteMatchRows({ games, rosters }) {
    await deleteRows({ games, matchRosters: rosters });
  },
  async appendRosters(rows) {
    await appendRows('matchRosters', rows);
  },
  async appendGames(rows) {
    await appendRows('games', rows);
  },
  async finalizeMatch(rowNumber, row) {
    await updateRows('matches', [{ rowNumber, values: row }]);
  },
};
