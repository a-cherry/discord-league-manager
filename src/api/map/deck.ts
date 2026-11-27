// Decks rows as the API serves them. Pure: no Sheets or Discord imports.
import { deckKey } from '../../match/parse.js';
import type { Row } from '../../sheet-rows.js';

export interface DeckResource {
  id: string;
  name: string;
  active: boolean;
}

// The id is deckKey(name), the same key a game's deck_id uses. Ingestion can't
// add two rows with one key (it matches typed names the same way), but a hand
// edit can. The first row is served, so an id is never listed twice, and the
// other is reported through `warn` for staff to merge.
export function mapDecks(rows: Row<'decks'>[], warn: (message: string) => void = () => {}): DeckResource[] {
  const seen = new Map<string, string>();
  const decks: DeckResource[] = [];
  for (const v of rows) {
    const id = deckKey(v.name);
    const first = seen.get(id);
    if (first !== undefined) {
      warn(`Decks has "${first}" and "${v.name}", which are the same deck; serving "${first}". Merge them by editing in place.`);
      continue;
    }
    seen.set(id, v.name);
    decks.push({ id, name: v.name, active: v.active.toLowerCase() === 'true' });
  }
  return decks;
}
