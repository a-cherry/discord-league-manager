// Mapper contract tests: the exact key set of every resource, so a column added
// to a tab later can't appear in a response by accident.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trainerIds } from '../src/api/ids.js';
import { mapDecks } from '../src/api/map/deck.js';
import { buildResources, warningLog } from '../src/api/map/index.js';
import { mapSeason } from '../src/api/map/season.js';
import { BUILD, fixtureLeague, fixtureResources, SAVED_AT, SHEET_ID, TAB_GID } from './api-fixtures.js';

const keys = (o: object) => Object.keys(o).sort();

test('a season has exactly season, start_date, end_date, active', () => {
  for (const s of fixtureResources().seasons) {
    assert.deepEqual(keys(s), ['active', 'end_date', 'season', 'start_date']);
  }
});

test('seasons: serial-number dates become YYYY-MM-DD, active and season become typed', () => {
  // readTabs reads unformatted values: a typed date arrives as a Sheets serial number.
  assert.deepEqual(mapSeason({ season: '5', start_date: '46327', end_date: '46387', active: 'TRUE' }), {
    season: 5, start_date: '2026-11-01', end_date: '2026-12-31', active: true,
  });
  assert.equal(mapSeason({ season: '4', start_date: '2026-09-01', end_date: '2026-10-31', active: 'FALSE' }).active, false);
  assert.equal(mapSeason({ season: '4', start_date: '2026-09-01', end_date: '2026-10-31', active: '' }).active, false);
});

test('a malformed season row throws, so the refresh keeps the last good snapshot', () => {
  assert.throws(() => mapSeason({ season: 'five', start_date: '2026-11-01', end_date: '2026-12-31', active: 'TRUE' }), /not a whole number/);
  assert.throws(() => mapSeason({ season: '5', start_date: 'Nov 1', end_date: '2026-12-31', active: 'TRUE' }), /not a date/);
});

// ---- Every resource's exact keys ---------------------------------------------

const SIDE_KEYS = ['deck', 'deck_id', 'nickname', 'result', 'trainer_id'];

test('a match, its source, rosters, games and game sides have exactly the agreed keys', () => {
  const [m] = fixtureResources().matches;
  assert.deepEqual(keys(m), [
    'games', 'id', 'left_gym_id', 'right_gym_id', 'rosters', 'score_left', 'score_right', 'season', 'source', 'stage', 'updated_at', 'week',
  ]);
  assert.deepEqual(keys(m.source!), ['spreadsheet_id', 'tab_gid']);
  assert.deepEqual(keys(m.rosters), ['left', 'right']);
  for (const g of m.games) {
    assert.deepEqual(keys(g), ['left', 'number', 'right']);
    assert.deepEqual(keys(g.left), SIDE_KEYS);
    assert.deepEqual(keys(g.right), SIDE_KEYS);
  }
});

test('a gym has exactly the agreed keys, and never the emote', () => {
  for (const g of fixtureResources().gyms) {
    assert.deepEqual(keys(g), ['abbreviation', 'division', 'divisions', 'id', 'logo_url', 'name', 'status']);
    for (const d of g.divisions) assert.deepEqual(keys(d), ['division', 'season']);
  }
});

test('a trainer has exactly the agreed keys, never discord_id or username', () => {
  for (const t of fixtureResources().trainers) {
    assert.deepEqual(keys(t), ['gym_id', 'id', 'leadership', 'nationality', 'nickname', 'role', 'status']);
  }
});

test('a deck has exactly id, name, active', () => {
  for (const d of fixtureResources().decks) assert.deepEqual(keys(d), ['active', 'id', 'name']);
});

// ---- Matches -----------------------------------------------------------------

test('the Example Match maps field by field from what ingestion saved', () => {
  const [m] = fixtureResources().matches;
  assert.deepEqual(
    { ...m, rosters: undefined, games: undefined },
    {
      id: 'M0001', season: 5, stage: 'Regular', week: 1, left_gym_id: 'G022', right_gym_id: 'G025',
      score_left: 9, score_right: 10, updated_at: SAVED_AT.toISOString(),
      source: { spreadsheet_id: SHEET_ID, tab_gid: TAB_GID }, rosters: undefined, games: undefined,
    },
  );
  assert.deepEqual(m.games.map((g) => g.number), Array.from({ length: 19 }, (_, i) => i + 1));
  const ids = trainerIds(BUILD.idSecret);
  assert.deepEqual(m.games[0].left, {
    trainer_id: ids('1100000000000000001'), nickname: 'Left Player 01',
    deck_id: 'megalucarioexlucario', deck: 'Mega Lucario ex Lucario', result: 'W',
  });
  assert.equal(m.games[10].left.result, 'DQL', 'results as stored');
  assert.equal(m.games[10].right.result, 'DQW');
});

test('rosters: each side its own gym, trainer ids hashed, no slot numbers', () => {
  const l = fixtureLeague();
  const [m] = fixtureResources(l).matches;
  const ids = trainerIds(BUILD.idSecret);
  const expected = (gym: string) => l.matchRosters.filter((r) => r.gym_id === gym).map((r) => ids(r.discord_id));
  assert.deepEqual(m.rosters.left, expected('G022'));
  assert.deepEqual(m.rosters.right, expected('G025'));
  assert.equal(m.rosters.left.length, 5);
  assert.ok(m.rosters.left.every((id) => /^t_[a-z2-7]{16}$/.test(id)));
});

test('games come back in game_number order whatever the row order', () => {
  const l = fixtureLeague();
  l.games.reverse();
  assert.deepEqual(fixtureResources(l).matches[0].games.map((g) => g.number), Array.from({ length: 19 }, (_, i) => i + 1));
});

test('a // row: no Trainer, so trainer, nickname and deck are null and the DQ result stays', () => {
  const l = fixtureLeague();
  Object.assign(l.games[0], { trainer_left: '', deck_left: '', result_left: 'DQL', result_right: 'DQW' });
  const [g] = fixtureResources(l).matches[0].games;
  assert.deepEqual(g.left, { trainer_id: null, nickname: null, deck_id: null, deck: null, result: 'DQL' });
  assert.equal(g.right.result, 'DQW');
  assert.notEqual(g.right.trainer_id, null);
});

test('a tab link that does not parse gives a null source', () => {
  const l = fixtureLeague();
  l.matches[0].tab_link = 'not a link';
  assert.equal(fixtureResources(l).matches[0].source, null);
  l.matches[0].tab_link = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
  assert.equal(fixtureResources(l).matches[0].source, null, 'no gid');
});

test('a game deck keyed the same as its Decks row, and a nickname from the current Trainers row', () => {
  const l = fixtureLeague();
  l.trainers[0].server_nickname = 'PGX | Renamed';
  const r = fixtureResources(l);
  assert.equal(r.matches[0].games[0].left.nickname, 'PGX | Renamed');
  const deckIds = new Set(r.decks.map((d) => d.id));
  for (const g of r.matches[0].games) for (const s of [g.left, g.right]) assert.ok(deckIds.has(s.deck_id!), s.deck!);
});

// ---- Gyms --------------------------------------------------------------------

test('gyms: division in the active season, one entry per season, logo url built from the base', () => {
  const [phoenix, summit, requiem] = fixtureResources().gyms;
  assert.equal(phoenix.division, 'A');
  assert.deepEqual(phoenix.divisions, [{ season: 4, division: 'B' }, { season: 5, division: 'A' }]);
  assert.equal(summit.division, 'B');
  assert.equal(requiem.status, 'relegated', 'relegated gyms stay listed');
  assert.equal(requiem.division, null);
  assert.deepEqual(requiem.divisions, []);
  assert.equal(phoenix.logo_url, `${BUILD.logoBaseUrl}/G022.png`);
  assert.equal(phoenix.abbreviation, null, 'blank abbreviation is null');
});

test('gyms: an abbreviation passes through, and a trailing slash on the logo base is not doubled', () => {
  const l = fixtureLeague();
  l.gyms[0].abbreviation = 'PHX';
  const [g] = buildResources(l, { ...BUILD, logoBaseUrl: `${BUILD.logoBaseUrl}/` }).gyms;
  assert.equal(g.abbreviation, 'PHX');
  assert.equal(g.logo_url, `${BUILD.logoBaseUrl}/G022.png`);
});

test('gyms: no active season means no current division', () => {
  const l = fixtureLeague();
  l.seasons[0].active = 'FALSE';
  assert.equal(fixtureResources(l).gyms[0].division, null);
});

// ---- Trainers ----------------------------------------------------------------

test('trainers: id, role, leadership and nationality as agreed', () => {
  const l = fixtureLeague();
  Object.assign(l.trainers[0], { role: 'non-playing', leadership: 'vice-leader', country: 'us' });
  Object.assign(l.trainers[1], { gym_id: '', status: 'inactive' });
  const [coach, left] = fixtureResources(l).trainers;
  assert.deepEqual(coach, {
    id: trainerIds(BUILD.idSecret)('1100000000000000001'), nickname: 'Left Player 01', gym_id: 'G022',
    role: 'coach', leadership: 'vice-leader', status: 'active', nationality: 'US',
  });
  assert.equal(left.role, 'player');
  assert.equal(left.leadership, null, 'none is null');
  assert.equal(left.gym_id, null);
  assert.equal(left.status, 'inactive');
  assert.equal(left.nationality, null, 'blank is the opt-out');
});

test('trainers: a country that is not two letters is served as null, with a warning naming no Discord ID', () => {
  const l = fixtureLeague();
  l.trainers[0].country = 'USA';
  const warnings: string[] = [];
  const [t] = buildResources(l, BUILD, (w) => void warnings.push(w)).trainers;
  assert.equal(t.nationality, null);
  assert.deepEqual(warnings, [
    `Trainers country for Left Player 01 (${t.id}) is "USA", not a two-letter country code; serving null.`,
  ]);
  assert.doesNotMatch(warnings[0], /\d{17,19}/);
});

test('trainer ids: t_ and 16 base32 characters, stable, and different with a different secret', () => {
  const ids = trainerIds('secret');
  const id = ids('1100000000000000001');
  assert.match(id, /^t_[a-z2-7]{16}$/);
  assert.equal(ids('1100000000000000001'), id);
  assert.notEqual(ids('1100000000000000002'), id);
  assert.notEqual(trainerIds('other')('1100000000000000001'), id);
  // Pinned, so a change to the encoding (which would change every id PKTR holds) fails here.
  assert.equal(trainerIds('test-id-secret')('1100000000000000001'), 't_3x2nrgcifar64kpc');
});

// ---- Decks -------------------------------------------------------------------

test('decks: id is the deck key, active a boolean', () => {
  assert.deepEqual(mapDecks([{ name: 'Mega Lucario ex Lucario', active: 'TRUE' }, { name: 'Old Deck', active: 'FALSE' }]), [
    { id: 'megalucarioexlucario', name: 'Mega Lucario ex Lucario', active: true },
    { id: 'olddeck', name: 'Old Deck', active: false },
  ]);
});

test('decks: two rows with one key serve the first, never one id twice, with a warning', () => {
  const warnings: string[] = [];
  const decks = mapDecks(
    [{ name: 'Hoopa ex', active: 'TRUE' }, { name: 'Other', active: 'TRUE' }, { name: 'Hoopa  EX', active: 'FALSE' }],
    (w) => void warnings.push(w),
  );
  assert.deepEqual(decks, [
    { id: 'hoopaex', name: 'Hoopa ex', active: true },
    { id: 'other', name: 'Other', active: true },
  ]);
  assert.deepEqual(warnings, ['Decks has "Hoopa ex" and "Hoopa  EX", which are the same deck; serving "Hoopa ex". Merge them by editing in place.']);
});

test('a clean league builds with no warnings', () => {
  const warnings: string[] = [];
  buildResources(fixtureLeague(), BUILD, (w) => void warnings.push(w));
  assert.deepEqual(warnings, []);
});

test('structural cells still fail the refresh: a score that is not a number', () => {
  const l = fixtureLeague();
  l.matches[0].score_left = 'nine';
  assert.throws(() => fixtureResources(l), /M0001 score_left is not a whole number: "nine"/);
});

test('warnings are logged when they appear and when they are fixed, not every refresh', () => {
  const logged: string[] = [];
  const log = warningLog((m) => void logged.push(m));
  log(['deck A']);
  log(['deck A']);
  log(['deck A', 'country B']);
  log(['country B']);
  log([]);
  assert.deepEqual(logged, ['warning: deck A', 'warning: country B', 'fixed: deck A', 'fixed: country B']);
});
