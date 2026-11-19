// An in-memory MatchStore. Rows are kept as written (typed); reads give
// strings, as readTabs does, with sheet row numbers starting at 2. Deleting
// rows moves the rows below up, as in a sheet. Every call is logged.
import type { MatchStore, SaveState } from '../src/match/store.js';
import type { LeagueSnapshot } from '../src/match/validate.js';
import { TABS, type TabKey } from '../src/schema.js';
import type { CellValue, Row, SheetRow } from '../src/sheet-rows.js';

type Stored = Record<string, CellValue>;
type Tabs = 'matches' | 'decks' | 'games' | 'matchRosters';

export class FakeMatchStore implements MatchStore {
  tabs: Record<Tabs, Stored[]> = { matches: [], decks: [], games: [], matchRosters: [] };
  calls: string[] = [];
  // Awaited inside every call, so concurrent saves can interleave if the lock lets them.
  delay: () => Promise<void> = () => new Promise((r) => setImmediate(r));

  constructor(private readonly base: Omit<LeagueSnapshot, 'matches' | 'decks'>) {}

  private read<K extends Tabs>(key: K): SheetRow<K>[] {
    return this.tabs[key].map((v, i) => ({
      rowNumber: i + 2,
      values: Object.fromEntries(TABS[key as TabKey].columns.map((c) => [c, String(v[c] ?? '')])) as Row<K>,
    }));
  }

  private async call(name: string) {
    this.calls.push(name);
    await this.delay();
  }

  async snapshot(): Promise<LeagueSnapshot> {
    await this.call('snapshot');
    return { ...this.base, matches: this.read('matches'), decks: this.read('decks') };
  }
  async readForSave(): Promise<SaveState> {
    await this.call('readForSave');
    return { matches: this.read('matches'), decks: this.read('decks'), games: this.read('games'), rosters: this.read('matchRosters') };
  }
  async appendDecks(names: string[]) {
    await this.call('appendDecks');
    this.tabs.decks.push(...names.map((name) => ({ name, active: true })));
  }
  async appendMatch(row: Stored) {
    await this.call('appendMatch');
    this.tabs.matches.push({ ...row });
    return this.tabs.matches.length + 1;
  }
  async setMatchStatus(rowNumber: number, status: string) {
    await this.call('setMatchStatus');
    this.tabs.matches[rowNumber - 2].status = status;
  }
  async deleteMatchRows({ games, rosters }: { games: number[]; rosters: number[] }) {
    await this.call('deleteMatchRows');
    const drop = (key: Tabs, rows: number[]) => {
      const gone = new Set(rows.map((n) => n - 2));
      this.tabs[key] = this.tabs[key].filter((_, i) => !gone.has(i));
    };
    drop('games', games);
    drop('matchRosters', rosters);
  }
  async appendRosters(rows: Stored[]) {
    await this.call('appendRosters');
    this.tabs.matchRosters.push(...rows.map((r) => ({ ...r })));
  }
  async appendGames(rows: Stored[]) {
    await this.call('appendGames');
    this.tabs.games.push(...rows.map((r) => ({ ...r })));
  }
  async finalizeMatch(rowNumber: number, row: Stored) {
    await this.call('finalizeMatch');
    this.tabs.matches[rowNumber - 2] = { ...row };
  }
}
