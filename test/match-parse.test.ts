import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkSentinels, clean, deckKey, deckMatcher, parseMatch, parseResult, resultsPair, type Result,
} from '../src/match/parse.js';
import { exampleMatch } from './fixtures.js';

test('parses the Example Match: config, gyms, roster slots, 19 games and the reported score', () => {
  const { tab, cells } = exampleMatch();
  const m = parseMatch(tab, cells);
  assert.deepEqual(m.config, { season: '5', stage: 'Regular', week: '1' });
  assert.deepEqual(m.gymIds, { left: 'G022', right: 'G025' });
  assert.deepEqual(m.slots.left.map((s) => s.cell), ['C18', 'F18', 'H18', 'C19', 'G19']);
  assert.deepEqual(m.slots.right[0], {
    side: 'right', slot: 1, cell: 'N18', name: 'Right Player 01', tableName: 'Right Player 01', discordId: '1200000000000000001',
  });
  assert.equal(m.games.length, 19);
  assert.deepEqual(m.games[10], {
    row: 31, trainerLeft: 'Left Player 03', deckLeft: 'Mega Blaziken ex Greninja', resultLeft: 'DQL',
    resultRight: 'DQW', deckRight: 'Suicune ex Baxcalibur', trainerRight: 'Right Player 03',
  });
  assert.deepEqual(m.reported, { left: '9', right: '10' });
});

test('a 19-digit Discord ID round-trips as a string', () => {
  const m = parseMatch('t', exampleMatch().cells);
  const id = m.slots.right[0].discordId;
  assert.equal(typeof id, 'string');
  assert.equal(id, '1200000000000000001');
  assert.notEqual(String(Number(id)), id, 'as a number it would lose precision');
});

test('a row with all six game cells empty is not a game; a partly filled row is', () => {
  const { cells } = exampleMatch();
  for (const c of ['C', 'G', 'K', 'M', 'N', 'R']) delete cells[`${c}25`];
  cells.L25 = '-'; // the separator column is not a game cell
  cells.G26 = '   ';
  for (const c of ['C', 'K', 'M', 'N', 'R']) delete cells[`${c}26`];
  cells.N30 = '';
  const rows = parseMatch('t', cells).games.map((g) => g.row);
  assert.ok(!rows.includes(25));
  assert.ok(!rows.includes(26), 'whitespace only counts as empty');
  assert.ok(rows.includes(30));
  assert.equal(rows.length, 17);
});

test('values are trimmed and repeated spaces and newlines collapsed', () => {
  assert.equal(clean('  Mega   Lucario\nex  '), 'Mega Lucario ex');
  assert.equal(clean(undefined), '');
  const { cells } = exampleMatch();
  cells.C21 = '  Left   Player 01 ';
  assert.equal(parseMatch('t', cells).games[0].trainerLeft, 'Left Player 01');
});

test('results read case-insensitively as the nine dropdown values and nothing else', () => {
  const expected: Record<string, Result> = {
    W: { kind: 'W' }, l: { kind: 'L' }, Tie: { kind: 'TIE' }, dqw: { kind: 'DQW' }, DQL: { kind: 'DQL' },
    'DQW (W)': { kind: 'DQW', reason: 'W' }, 'dql (w)': { kind: 'DQL', reason: 'W' },
    ' DQW   (R) ': { kind: 'DQW', reason: 'R' }, 'DQL (R)': { kind: 'DQL', reason: 'R' },
  };
  for (const [text, r] of Object.entries(expected)) assert.deepEqual(parseResult(text), r, text);
  for (const text of ['DQL ( R )', 'DQL(R)', 'DQL (X)', 'WIN', 'T', '', '-']) assert.equal(parseResult(text), undefined, text);
});

test('results pair as W/L, L/W, TIE/TIE, or DQW and DQL with the same reason', () => {
  const r = (s: string) => parseResult(s)!;
  for (const [a, b] of [['W', 'L'], ['L', 'W'], ['TIE', 'TIE'], ['DQW', 'DQL'], ['DQL', 'DQW'], ['DQW (W)', 'DQL (W)'], ['DQL (R)', 'DQW (R)']]) {
    assert.ok(resultsPair(r(a), r(b)), `${a}/${b}`);
  }
  for (const [a, b] of [['W', 'W'], ['L', 'L'], ['W', 'TIE'], ['DQW', 'W'], ['DQW', 'L'], ['DQW (W)', 'DQL (R)'], ['DQW', 'DQL (W)'], ['DQW', 'DQW']]) {
    assert.ok(!resultsPair(r(a), r(b)), `${a}/${b}`);
  }
});

test('deck keys ignore case and spacing but keep word order', () => {
  assert.equal(deckKey('Mega Lucario ex Lucario'), deckKey('mega  lucario EX lucario'));
  assert.equal(deckKey('MegaLucario ex Lucario'), deckKey('Mega Lucario ex Lucario'));
  assert.notEqual(deckKey('Iron Valiant Iron Crown'), deckKey('Iron Crown Iron Valiant'));
});

test('the deck matcher keeps the stored spelling and lists each new deck once, as first typed', () => {
  const m = deckMatcher(['Mega Lucario ex Lucario', 'Inactive Deck']);
  assert.equal(m.resolve('mega  lucario EX lucario'), 'Mega Lucario ex Lucario');
  assert.equal(m.resolve('inactive deck'), 'Inactive Deck');
  assert.equal(m.resolve('Mega Lucario Exx'), 'Mega Lucario Exx');
  assert.equal(m.resolve('MEGA LUCARIO EXX'), 'Mega Lucario Exx', 'a second spelling of a new deck uses the first');
  assert.equal(m.resolve('Lucario Mega Lucario ex'), 'Lucario Mega Lucario ex', 'reversed names stay separate');
  assert.deepEqual(m.added, ['Mega Lucario Exx', 'Lucario Mega Lucario ex']);
});

test('the sentinel check passes the template and names each cell that moved', () => {
  const { cells } = exampleMatch();
  assert.deepEqual(checkSentinels(cells), []);
  cells.AK1 = 'Left gym';
  delete cells.O17;
  assert.deepEqual(checkSentinels(cells), [
    'AK1 reads "Left gym", expected "Left gym_id"',
    'O17 reads "", expected "ROSTER"',
  ]);
});
