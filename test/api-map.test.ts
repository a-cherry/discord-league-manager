// Mapper contract tests: the exact key set of every resource, so a column added
// to a tab later can't appear in a response by accident.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildResources } from '../src/api/map/index.js';
import { mapSeason } from '../src/api/map/season.js';
import { fixtureLeague } from './api-fixtures.js';

const keys = (o: object) => Object.keys(o).sort();

test('a season has exactly season, start_date, end_date, active', () => {
  for (const s of buildResources(fixtureLeague()).seasons) {
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
