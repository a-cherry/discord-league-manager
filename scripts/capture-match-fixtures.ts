// Builds the test fixtures for match ingestion. Read-only against the League DB.
//   test/fixtures/example-match.json  the Example Match tab as A1 cells, FORMATTED_VALUE
//   test/fixtures/league.json         the League DB rows that tab needs
//
//   npm run capture-match-fixtures -- <real-match.json>
//
// The Example Match tab no longer exists in the final template, so the source
// is a cell file kept outside the repo ({ tab, expected, cells }). Its players
// are replaced with made-up ones (see anonymize-fixtures.ts), so the fixtures
// hold no real names or Discord IDs.
//
// league.json takes Seasons and one relegated gym from the League DB in .env
// (dev). Dev doesn't hold the match's gyms or Trainers, so those are built
// from the match itself: both gyms active, all ten Trainers active on their
// side's gym. Matches and Decks are empty.
import './load-env.js';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Row } from '../src/sheet-rows.js';
import { readTabs } from '../src/sheet-rows.js';
import { anonymizeMatch } from './anonymize-fixtures.js';

const OUT = 'test/fixtures';
// Emotes as they are in production; they aren't sensitive.
const EMOTES: Record<string, string> = { G022: ':phoenix~1:', G025: ':summit:' };

const source = parseArgs({ allowPositionals: true, strict: false }).positionals[0];
if (!source) throw new Error('Usage: npm run capture-match-fixtures -- <real-match.json>');
const real = JSON.parse(await readFile(source, 'utf8'));
const { match, players } = anonymizeMatch(real);
const { cells } = match;

const sides = [
  { gymId: cells.AK2, name: cells.F11, side: 'left' },
  { gymId: cells.AL2, name: cells.N11, side: 'right' },
] as const;
if (sides.some((s) => !s.gymId || !s.name)) throw new Error('AK2/AL2 or F11/N11 is blank in the source');

const [dbGyms, seasons] = await readTabs('gyms', 'seasons');
const relegated = dbGyms.find((g) => g.values.status === 'relegated' && !sides.some((s) => s.gymId === g.values.gym_id));
if (!relegated) throw new Error('No relegated gym in the League DB to use as a fixture');

const gyms = [
  ...sides.map((s, i) => ({
    rowNumber: i + 2,
    values: { gym_id: s.gymId, name: s.name, abbreviation: '', status: 'active', emote: EMOTES[s.gymId] ?? '' } satisfies Row<'gyms'>,
  })),
  relegated,
];
const trainers = players.map((p, i) => ({
  rowNumber: i + 2,
  values: {
    discord_id: p.discordId,
    server_nickname: p.name,
    username: p.name.replace(/^.* \| /, '').toLowerCase().replaceAll(' ', '_'),
    country: '',
    gym_id: sides.find((s) => s.side === p.side)!.gymId,
    role: 'trainer',
    leadership: 'none',
    status: 'active',
  } satisfies Row<'trainers'>,
}));
const league = { gyms, trainers, seasons, matches: [], decks: [] };

await writeFile(`${OUT}/example-match.json`, JSON.stringify(match, null, 2) + '\n');
await writeFile(`${OUT}/league.json`, JSON.stringify(league, null, 2) + '\n');
console.log(`Wrote ${OUT}/example-match.json and ${OUT}/league.json`);
