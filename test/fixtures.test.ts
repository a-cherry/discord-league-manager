import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellsFromRanges } from '../src/match/parse.js';
import { exampleMatch, league } from './fixtures.js';

test('example match fixture has the anchors, ten named Trainers and 19 game rows', () => {
  const { cells, expected } = exampleMatch();
  assert.equal(cells.AK2, 'G022');
  assert.equal(cells.AL2, 'G025');
  assert.deepEqual([cells.AM2, cells.AN2, cells.AO2], ['5', 'Regular', '1']);
  for (let row = 4; row <= 13; row++) assert.ok(cells[`AO${row}`] && cells[`AP${row}`], `AO${row}:AP${row}`);
  const games = [];
  for (let row = 21; row <= 39; row++) if (cells[`C${row}`]) games.push(row);
  assert.equal(games.length, expected.gamesRead);
  assert.deepEqual([cells.K41, cells.M41], [String(expected.scoreLeft), String(expected.scoreRight)]);
});

test('fixtures hold no real players: names and Discord IDs are the made-up ones', () => {
  const { cells } = exampleMatch();
  for (let row = 4; row <= 13; row++) {
    assert.match(cells[`AO${row}`], /^(.* \| )?(Left|Right) Player \d\d$/);
    assert.match(cells[`AP${row}`], /^1[12]0{15}\d\d$/);
  }
});

test('Discord IDs in the fixtures stay strings and the two fixtures agree', () => {
  const { cells } = exampleMatch();
  assert.equal(cells.AP9, '1200000000000000001');
  const ids = new Set(league().trainers.map((t) => t.values.discord_id));
  for (let row = 4; row <= 13; row++) assert.ok(ids.has(cells[`AP${row}`]), `AP${row} is in Trainers`);
});

test('league fixture has the two match gyms, a relegated gym, ten Trainers and Season 5 active', () => {
  const { gyms, trainers, seasons, matches, decks } = league();
  assert.deepEqual(gyms.slice(0, 2).map((g) => [g.values.gym_id, g.values.status]), [
    ['G022', 'active'],
    ['G025', 'active'],
  ]);
  assert.equal(gyms.length, 3);
  assert.equal(gyms[2].values.status, 'relegated');
  assert.equal(trainers.length, 10);
  assert.ok(seasons.some((s) => s.values.season === '5' && s.values.active.toLowerCase() === 'true'));
  assert.equal(matches.length, 0);
  assert.equal(decks.length, 0);
});

test('cellsFromRanges maps batchGet arrays to A1 cells and drops blanks', () => {
  const cells = cellsFromRanges([
    [['Left gym_id', 'Right gym_id'], ['G022', 'G025', '5']],
    [['ROSTER', '', '', '', '', '', '', '', '', '', '', '', 'ROSTER']],
    [[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], [], ['', '', '', '', '', '', '', '', '9', '', '10']],
  ]);
  assert.deepEqual(cells, {
    AK1: 'Left gym_id', AL1: 'Right gym_id', AK2: 'G022', AL2: 'G025', AM2: '5',
    C17: 'ROSTER', O17: 'ROSTER', K41: '9', M41: '10',
  });
});
