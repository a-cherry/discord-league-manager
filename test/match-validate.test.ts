import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MatchCells, parseMatch, parseResult } from '../src/match/parse.js';
import { type LeagueSnapshot, type ValidateOptions, sequenceCheck, validate } from '../src/match/validate.js';
import type { SheetRow } from '../src/sheet-rows.js';
import { exampleMatch, league } from './fixtures.js';

// The fixture's seven decks, so the Example Match has no New deck warnings.
const FIXTURE_DECKS = [
  'Mega Lucario ex Lucario', 'Hoopa Ex Mega Sableye EX', 'Mega Altaria ex Espeon', 'Vespiquen ex Shuckle ex',
  'Mega Blaziken ex Greninja', 'Hoopa Ex Mega Absol EX', 'Suicune ex Baxcalibur',
];
const deckRows = (names: string[], active = 'TRUE'): SheetRow<'decks'>[] =>
  names.map((name, i) => ({ rowNumber: i + 2, values: { name, active } }));

function snapshot(): LeagueSnapshot {
  return { ...league(), decks: deckRows(FIXTURE_DECKS) };
}

function run(
  editCells: (cells: MatchCells) => void = () => {},
  editDb: (db: LeagueSnapshot) => void = () => {},
  options?: ValidateOptions,
) {
  const { tab, cells } = exampleMatch();
  editCells(cells);
  const db = snapshot();
  editDb(db);
  return validate(parseMatch(tab, cells), db, options);
}

const clearRow = (cells: MatchCells, row: number) => {
  for (const c of ['C', 'G', 'K', 'M', 'N', 'R']) delete cells[`${c}${row}`];
};
const setRow = (cells: MatchCells, row: number, left: string, right: string) => {
  cells[`K${row}`] = left;
  cells[`M${row}`] = right;
};
const matchRow = (n: number, v: Partial<SheetRow<'matches'>['values']>): SheetRow<'matches'> => ({
  rowNumber: n + 2,
  values: {
    match_id: `M${String(n + 1).padStart(4, '0')}`, season: '5', stage: 'Regular', week: '1',
    gym_left_id: `X${n}a`, gym_right_id: `X${n}b`, score_left: '10', score_right: '8', status: 'complete',
    tab_link: '', submitted_by: '', submitted_at: '', ...v,
  },
});

// ---- The fixture -------------------------------------------------------------

test('the Example Match validates with no errors and no warnings', () => {
  const { expected } = exampleMatch();
  const v = run();
  assert.deepEqual(v.errors, expected.errors);
  assert.deepEqual(v.warnings, expected.warnings);
  assert.deepEqual(v.plan!.score, { left: expected.scoreLeft, right: expected.scoreRight });
  assert.equal(v.plan!.games.length, expected.gamesRead);
  assert.deepEqual(v.plan!.identity, { season: 5, stage: 'Regular', week: 1, gymLeftId: 'G022', gymRightId: 'G025' });
  assert.equal(v.plan!.rosters.left.length, 5);
  assert.deepEqual(v.plan!.games[10], {
    trainerLeft: '1100000000000000003', deckLeft: 'Mega Blaziken ex Greninja', resultLeft: 'DQL',
    resultRight: 'DQW', deckRight: 'Suicune ex Baxcalibur', trainerRight: '1200000000000000003',
  });
  assert.match(v.hash!, /^[0-9a-f]{12}$/);
});

test('against the empty Decks of league.json, each of the seven decks is a New deck warning', () => {
  const { tab, cells } = exampleMatch();
  const v = validate(parseMatch(tab, cells), league());
  assert.deepEqual(v.errors, []);
  assert.deepEqual([...v.warnings].sort(), FIXTURE_DECKS.map((d) => `New deck: ${d}`).sort());
  assert.deepEqual(v.warnings.slice(0, 2), ['New deck: Mega Lucario ex Lucario', 'New deck: Hoopa Ex Mega Sableye EX'], 'in the order first seen');
});

// ---- Season, stage and week ---------------------------------------------------

test('a blank config cell fails', () => {
  assert.deepEqual(run((c) => delete c.AO2).errors, ['Week is blank']);
  assert.deepEqual(run((c) => delete c.AM2).errors, ['Season is blank']);
  assert.deepEqual(run((c) => delete c.AN2).errors, ['Stage is blank']);
});

test('season, stage and week outside the canonical forms fail', () => {
  for (const week of ['05', '1.0', 'Week 1', '0', '-1']) {
    assert.deepEqual(run((c) => (c.AO2 = week)).errors, [`Week "${week}" is not a whole number`], week);
  }
  assert.deepEqual(run((c) => (c.AM2 = 'S5')).errors, ['Season "S5" is not a whole number']);
  for (const stage of ['regular', 'Playoffs', 'Reg']) {
    assert.deepEqual(run((c) => (c.AN2 = stage)).errors, [`Stage "${stage}" must be Regular, Playoff or Playout`]);
  }
  assert.deepEqual(run((c) => (c.AN2 = 'Playoff')).errors, []);
});

test('the season must be the active Seasons row, read as TRUE in any case', () => {
  assert.deepEqual(run((c) => (c.AM2 = '4')).errors, ['Season 4 is not the active season (5)']);
  assert.deepEqual(run(undefined, (db) => (db.seasons[0].values.active = 'true')).errors, []);
  assert.deepEqual(run(undefined, (db) => (db.seasons[0].values.active = 'FALSE')).errors, ['No season is active in the League DB']);
});

test('an error value in a config cell fails', () => {
  assert.deepEqual(run((c) => (c.AM2 = '#REF!')).errors, ['Season cell shows #REF!']);
  assert.deepEqual(run((c) => (c.AN2 = '#N/A')).errors, ['Stage cell shows #N/A']);
});

// ---- Gyms ---------------------------------------------------------------------

test('both gyms must exist, differ and be active', () => {
  const relegated = league().gyms[2].values;
  assert.deepEqual(run((c) => (c.AK2 = relegated.gym_id)).errors.slice(0, 1), [`Left gym ${relegated.name} is relegated`]);
  assert.deepEqual(run((c) => (c.AL2 = 'G999')).errors.slice(0, 1), ['Right gym G999 is not a gym']);
  assert.deepEqual(run((c) => (c.AL2 = 'G022')).errors.slice(0, 1), ['Both sides are the same gym, Phoenix']);
  assert.deepEqual(run((c) => delete c.AK2).errors.slice(0, 1), ['Left gym is blank']);
  assert.deepEqual(run(undefined, (db) => (db.gyms[1].values.status = 'inactive')).errors, ['Right gym Summit is inactive']);
});

// ---- Week cap -----------------------------------------------------------------

function fullLeague(db: LeagueSnapshot, matches: SheetRow<'matches'>[]) {
  for (let i = 0; i < 30; i++) {
    db.gyms.push({ rowNumber: 100 + i, values: { gym_id: `X${i}`, name: `Gym ${i}`, abbreviation: '', status: 'active', emote: '' } });
  }
  db.matches = matches;
}

test('a week that already has half the active gyms in complete matches fails', () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => matchRow(i, {}));
  assert.deepEqual(run(undefined, (db) => fullLeague(db, sixteen)).errors, [
    'S5 Regular W1 already has 16 matches. Check the season, stage and week cells',
  ]);
});

test('the week cap counts complete matches only, and not this match', () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => matchRow(i, {}));
  const pending = matchRow(15, { status: 'pending' });
  const thisOne = matchRow(16, { gym_left_id: 'G025', gym_right_id: 'G022', score_left: '10', score_right: '9' });
  const v = run(undefined, (db) => fullLeague(db, [...fifteen, pending, thisOne]));
  assert.deepEqual(v.errors, [], 'this match, saved with the sides swapped, is not counted');
  const otherWeek = matchRow(17, { week: '2' });
  assert.deepEqual(run(undefined, (db) => fullLeague(db, [...fifteen, otherWeek])).errors, []);
});

test('the week cap is half the active gyms, rounded down', () => {
  // Two active gyms in league.json: a cap of 1.
  assert.deepEqual(run(undefined, (db) => (db.matches = [matchRow(0, {})])).errors, [
    'S5 Regular W1 already has 1 matches. Check the season, stage and week cells',
  ]);
});

// ---- Rosters --------------------------------------------------------------------

test('a side with fewer than 3 Trainers fails; 3 passes', () => {
  const blankSlots = (c: MatchCells, slots: string[], rows: number[]) => {
    for (const s of slots) delete c[s];
    for (const r of rows) { delete c[`AO${r}`]; delete c[`AP${r}`]; }
  };
  const two = run((c) => blankSlots(c, ['S18', 'N19', 'R19'], [11, 12, 13]));
  assert.ok(two.errors.includes('Summit lists 2 Trainers'));
  const three = run((c) => blankSlots(c, ['N19', 'R19'], [12, 13]));
  assert.ok(!three.errors.some((e) => e.includes('lists')));
});

test('a filled slot whose ID is NOT FOUND, blank or an error value is unresolved', () => {
  for (const id of ['NOT FOUND', '#N/A', '']) {
    const v = run((c) => (c.AP6 = id));
    assert.deepEqual(v.errors, ['Left roster slot 3: Left Player 03 not found'], id);
  }
});

test('a resolved ID must exist in Trainers', () => {
  const v = run(undefined, (db) => (db.trainers = db.trainers.filter((t) => t.values.discord_id !== '1200000000000000004')));
  assert.deepEqual(v.errors, ['Right roster slot 4: Right Player 04 is not in the League DB']);
});

test('the same ID in two slots is one roster entry', () => {
  const v = run(
    (c) => {
      c.G19 = 'Left Player 01';
      c.AO8 = 'Left Player 01';
      c.AP8 = '1100000000000000001';
      for (let r = 36; r <= 39; r++) c[`C${r}`] = 'Left Player 01';
    },
    undefined,
    { sequenceRules: 'warn' }, // Left Player 01 now plays after a second loss
  );
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.plan!.rosters.left, ['1100000000000000001', '1100000000000000002', '1100000000000000003', '1100000000000000004']);
});

// ---- Game rows ------------------------------------------------------------------

test('no games fails', () => {
  const v = run((c) => { for (let r = 21; r <= 39; r++) clearRow(c, r); });
  assert.ok(v.errors.includes('No games recorded'));
});

test('a game row must have all six cells', () => {
  assert.deepEqual(run((c) => delete c.K27).errors, ['Row 27: left result blank']);
  // A forfeit-style row: blank Trainers, // decks.
  const forfeit = run((c) => { delete c.C21; delete c.R21; c.G21 = '//'; c.N21 = '//'; });
  assert.ok(forfeit.errors.includes('Row 21: left Trainer and right Trainer blank'));
  // A Trainer and a deck but no result.
  assert.deepEqual(run((c) => { delete c.K25; delete c.M25; }).errors, ['Row 25: left result and right result blank']);
});

test('an error value in a game row or the reported score fails', () => {
  assert.deepEqual(run((c) => (c.G25 = '#N/A')).errors, ['Row 25: left deck shows #N/A']);
  assert.deepEqual(run((c) => (c.K41 = '#N/A')).errors, ['Reported left score (K41) shows #N/A']);
  assert.deepEqual(run((c) => (c.M41 = '#VALUE!')).errors, ['Reported right score (M41) shows #VALUE!']);
});

test('results must pair', () => {
  assert.ok(run((c) => setRow(c, 21, 'W', 'W')).errors.includes('Row 21: both sides W'));
  assert.ok(run((c) => setRow(c, 31, 'DQW', 'W')).errors.includes("Row 31: results DQW and W don't pair"));
});

test('results are read case-insensitively and stored as written', () => {
  const v = run((c) => { for (let r = 21; r <= 39; r++) { c[`K${r}`] = c[`K${r}`].toLowerCase(); c[`M${r}`] = c[`M${r}`].toLowerCase(); } });
  assert.deepEqual(v.errors, []);
  assert.equal(v.plan!.games[10].resultLeft, 'dql');
});

test('a result spelled DQL ( R ) is not recognized', () => {
  assert.deepEqual(run((c) => setRow(c, 31, 'DQL ( R )', 'DQW (R)')).errors, ['Row 31: left result "DQL \\( R \\)" is not recognized']);
});

test('each DQ value counts as named; matching reason codes pass, mixed fail', () => {
  for (const [l, r] of [['DQL (W)', 'DQW (W)'], ['DQL (R)', 'DQW (R)'], ['dql (w)', 'DQW (W)']]) {
    const v = run((c) => setRow(c, 31, l, r));
    assert.deepEqual(v.errors, [], `${l}/${r}`);
    assert.deepEqual(v.plan!.score, { left: 9, right: 10 });
    assert.equal(v.plan!.games[10].resultLeft, l);
  }
  assert.ok(run((c) => setRow(c, 31, 'DQL (W)', 'DQW (R)')).errors.includes("Row 31: results DQL \\(W\\) and DQW \\(R\\) don't pair"));
  assert.ok(run((c) => setRow(c, 31, 'DQL', 'DQW (W)')).errors.some((e) => e.startsWith('Row 31: results')));
});

test('a name outside the roster slots must be an active Trainer on that side\'s gym', () => {
  // Atem plays all of Right Player 02's games and is in no League DB gym.
  const v = run((c) => { for (let r = 25; r <= 29; r++) c[`R${r}`] = 'Atem'; });
  assert.deepEqual(v.errors, ["Row 25: Atem isn't in Summit's roster slots, and no active Summit Trainer has that server nickname"]);
  // A left-side name on the right side is not a Summit Trainer.
  assert.ok(run((c) => (c.R25 = 'Left Player 01')).errors[0].startsWith("Row 25: Left Player 01 isn't in Summit's roster slots"));
});

// ---- Mid-match subs ---------------------------------------------------------------

// Right Player 02 wins row 25, loses row 26 and moves to their second deck; the
// sub takes that deck for rows 27 to 29: W, W, L.
const SUB_ID = '1200000000000000099';
const addSub = (db: LeagueSnapshot, v: Partial<SheetRow<'trainers'>['values']> = {}) =>
  db.trainers.push({
    rowNumber: 99,
    values: {
      discord_id: SUB_ID, server_nickname: 'Sub Player', username: 'sub_player', country: '', gym_id: 'G025',
      role: 'trainer', leadership: 'none', status: 'active', ...v,
    },
  });
const subIn = (rows: number[], name = 'Sub Player') => (c: MatchCells) => { for (const r of rows) c[`R${r}`] = name; };

test('a mid-match sub is a warning, and each row is credited to whoever played it', () => {
  const v = run(subIn([27, 28, 29]), (db) => addSub(db));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['Row 27: Sub Player subbed in for Right Player 02']);
  const games = v.plan!.games;
  assert.deepEqual(games.slice(4, 9).map((g) => [g.trainerRight, g.resultRight]), [
    ['1200000000000000002', 'W'],
    ['1200000000000000002', 'L'],
    [SUB_ID, 'W'],
    [SUB_ID, 'W'],
    [SUB_ID, 'L'],
  ]);
  assert.equal(v.plan!.rosters.right.length, 6);
  assert.equal(v.plan!.rosters.right[5], SUB_ID);
  assert.deepEqual(v.plan!.score, { left: 9, right: 10 });
});

test('the sub is found by server_nickname, ignoring case and spacing', () => {
  assert.deepEqual(run(subIn([27, 28, 29], 'sub  player'), (db) => addSub(db)).errors, []);
});

test('normal rotation after a second loss is not a sub', () => {
  const v = run();
  assert.ok(!v.warnings.some((w) => w.includes('subbed in')));
});

test('the sub continues the replaced Trainer\'s record: shared losses and repeat', () => {
  // The sub plays row 30 as well: the pair's losses are rows 26 and 29.
  const extra = run(subIn([27, 28, 29, 30]), (db) => addSub(db));
  assert.deepEqual(extra.errors, ['Row 30: Right Player 02 and Sub Player already have 2 losses']);
  // The sub plays the deck Right Player 02 won with before losing: a repeat after a win.
  const repeat = run((c) => { subIn([27, 28, 29])(c); for (const r of [27, 28, 29]) c[`N${r}`] = 'Hoopa Ex Mega Absol EX'; }, (db) => addSub(db));
  assert.ok(repeat.errors.includes('Row 27: Sub Player repeats Hoopa Ex Mega Absol EX after winning with it'));
  assert.ok(repeat.errors.includes('Summit used 3 repeats: Right Player 01, Sub Player, Right Player 03'));
});

test('a sub on a winning side that used few Trainers is still a sub', () => {
  // Phoenix loses ten games straight; Summit wins all ten with Right Player 01,
  // who hands over to the sub after five. Summit's games name only 2 Trainers.
  const v = run((c) => {
    for (let r = 21; r <= 39; r++) clearRow(c, r);
    for (let i = 0; i < 10; i++) {
      const r = 21 + i;
      Object.assign(c, {
        [`C${r}`]: `Left Player 0${Math.floor(i / 2) + 1}`, [`G${r}`]: i % 2 ? 'Hoopa Ex Mega Sableye EX' : 'Mega Lucario ex Lucario',
        [`K${r}`]: 'L', [`M${r}`]: 'W', [`N${r}`]: 'Suicune ex Baxcalibur', [`R${r}`]: i < 5 ? 'Right Player 01' : 'Sub Player',
      });
    }
    c.K41 = '0';
    c.M41 = '10';
  }, (db) => addSub(db));
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['Row 26: Sub Player subbed in for Right Player 01']);
  assert.deepEqual(v.plan!.games.slice(4, 6).map((g) => g.trainerRight), ['1200000000000000001', SUB_ID]);
});

test('a Trainer outside the roster slots who starts a fresh turn needs a roster slot', () => {
  // Row 29 is Right Player 02's second loss; the newcomer plays row 30, then Right Player 03 carries on.
  const v = run(subIn([30]), (db) => addSub(db));
  assert.deepEqual(v.errors, [
    "Row 30: Sub Player isn't in Summit's roster slots and came in after Right Player 02's second loss, not mid-turn. Put them in a roster slot",
  ]);
});

test('a sub must be an active Trainer on that side\'s gym, matched once', () => {
  const sub = subIn([27, 28, 29]);
  const notFound = "Row 27: Sub Player isn't in Summit's roster slots, and no active Summit Trainer has that server nickname";
  assert.deepEqual(run(sub).errors, [notFound]);
  assert.deepEqual(run(sub, (db) => addSub(db, { gym_id: 'G022' })).errors, [notFound]);
  assert.deepEqual(run(sub, (db) => addSub(db, { status: 'suspended' })).errors, [notFound]);
  const twice = run(sub, (db) => { addSub(db); addSub(db, { discord_id: '1200000000000000098' }); });
  assert.deepEqual(twice.errors, ['Row 27: Sub Player matches 2 Summit Trainers in the League DB']);
  const rostered = run(sub, (db) => (db.trainers.find((t) => t.values.discord_id === '1200000000000000005')!.values.server_nickname = 'Sub Player'));
  assert.deepEqual(rostered.errors, ["Row 27: Sub Player is already on Summit's roster under another name"]);
});

test('a sub plays one unbroken stretch after a rostered Trainer', () => {
  assert.deepEqual(run(subIn([27, 29]), (db) => addSub(db)).errors, ['Row 27: Sub Player plays in two separate stretches; a sub plays one']);
  assert.deepEqual(run(subIn([21]), (db) => addSub(db)).errors, ['Row 21: Sub Player subbed in with no rostered Summit Trainer before them']);
});

test('a side can have two subs, each replacing a rostered Trainer', () => {
  // Right Player 05 wins row 37 and loses row 38; a second sub plays row 39.
  const v = run((c) => { subIn([27, 28, 29])(c); c.R39 = 'Second Sub'; }, (db) => {
    addSub(db);
    addSub(db, { discord_id: '1200000000000000098', server_nickname: 'Second Sub' });
  });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['Row 27: Sub Player subbed in for Right Player 02', 'Row 39: Second Sub subbed in for Right Player 05']);
  assert.equal(v.plan!.rosters.right.length, 7);
});

test('a sub for a sub is not supported', () => {
  const v = run((c) => { c.R27 = 'Sub Player'; c.R28 = 'Second Sub'; }, (db) => {
    addSub(db);
    addSub(db, { discord_id: '1200000000000000098', server_nickname: 'Second Sub' });
  });
  assert.deepEqual(v.errors, ['Row 28: Second Sub subbed in with no rostered Summit Trainer before them']);
});

test('possessives: a gym name ending in s', () => {
  const v = run((c) => (c.R25 = 'Atem'), (db) => (db.gyms[1].values.name = 'Pocket Refs'));
  assert.equal(v.errors[0], "Row 25: Atem isn't in Pocket Refs' roster slots, and no active Pocket Refs Trainer has that server nickname");
});

// ---- Sequence rules -------------------------------------------------------------

const seq = (...games: [string, string][]) =>
  sequenceCheck(games.map(([deck, result], i) => ({ row: 21 + i, deck, result: parseResult(result)! })));

test('no Trainer plays after a second loss or tie', () => {
  assert.deepEqual(seq(['A', 'L'], ['B', 'L'], ['B', 'W']).afterSecondLoss, { row: 23, tie: false });
  assert.deepEqual(seq(['A', 'TIE'], ['B', 'L'], ['B', 'W']).afterSecondLoss, { row: 23, tie: true });
  assert.deepEqual(seq(['A', 'W'], ['A', 'DQL (W)'], ['B', 'L'], ['C', 'W']).afterSecondLoss, { row: 24, tie: false });
  assert.equal(seq(['A', 'W'], ['A', 'L'], ['B', 'W'], ['B', 'L']).afterSecondLoss, undefined);
  const v = run((c) => (c.C24 = 'Left Player 01'));
  assert.deepEqual(v.errors, ['Row 24: Left Player 01 already has 2 losses']);
});

test('a repeat after a single first-game loss is legal', () => {
  assert.deepEqual(seq(['A', 'L'], ['A', 'W'], ['A', 'W'], ['A', 'L']).repeat, { row: 22, deck: 'A' });
  assert.equal(seq(['A', 'L'], ['B', 'W'], ['B', 'L']).repeat, undefined);
  assert.deepEqual(seq(['A', 'DQL'], ['a', 'W']).repeat, { row: 22, deck: 'a' }, 'deck matched ignoring case');
});

test('a repeat after winning, or after a tie, is not', () => {
  assert.deepEqual(seq(['A', 'W'], ['A', 'L'], ['A', 'W']).repeat, { row: 23, deck: 'A', illegal: 'win' });
  assert.deepEqual(seq(['A', 'TIE'], ['A', 'W']).repeat, { row: 22, deck: 'A', illegal: 'tie' });
  const v = run((c) => { for (const r of [27, 28, 29]) c[`N${r}`] = 'Hoopa Ex Mega Absol EX'; });
  assert.ok(v.errors.includes('Row 27: Right Player 02 repeats Hoopa Ex Mega Absol EX after winning with it'));
});

test('at most 2 repeats per side', () => {
  const v = run((c) => { for (const r of [27, 28, 29]) c[`N${r}`] = 'Hoopa Ex Mega Absol EX'; });
  assert.ok(v.errors.includes('Summit used 3 repeats: Right Player 01, Right Player 02, Right Player 03'));
});

test('a DQ (R) row is skipped by the repeat count and the repeat legality checks', () => {
  assert.equal(seq(['A', 'W'], ['A', 'L'], ['A', 'DQL (R)']).repeat, undefined);
  assert.deepEqual(seq(['A', 'W'], ['A', 'L'], ['A', 'DQL (R)']).afterSecondLoss, undefined);
  assert.deepEqual(seq(['A', 'L'], ['A', 'DQW (R)'], ['A', 'W']).repeat, { row: 23, deck: 'A' });
  // Left Player 03 lost game one and repeated; marking the last game as (R) leaves rows 29-30 as the repeat.
  assert.deepEqual(run((c) => setRow(c, 31, 'DQL (R)', 'DQW (R)')).errors, []);
});

test('a TIE adds one to each side and counts as a loss for the sequence rules', () => {
  // Row 39 becomes a tie: 10-10, so the sheet fails with the redo hint.
  const v = run((c) => { setRow(c, 39, 'TIE', 'TIE'); c.K41 = '10'; c.M41 = '10'; });
  assert.deepEqual(v.errors, ['No winner: 10-10. If a 9-9 tie was replayed, leave the tied game off and record only the replay']);
  // Left Player 05 tied game one then repeats the tied deck: a repeat after a tie.
  assert.deepEqual(seq(['A', 'TIE'], ['A', 'L']).repeat, { row: 22, deck: 'A', illegal: 'tie' });
});

test('GGB_SEQUENCE_RULES=warn makes the three sequence rules warnings', () => {
  const edit = (c: MatchCells) => { c.C24 = 'Left Player 01'; for (const r of [27, 28, 29]) c[`N${r}`] = 'Hoopa Ex Mega Absol EX'; };
  const failing = run(edit);
  assert.equal(failing.errors.length, 3);
  const warned = run(edit, undefined, { sequenceRules: 'warn' });
  assert.deepEqual(warned.errors, []);
  assert.deepEqual(warned.warnings, failing.errors);
  assert.ok(warned.plan);
});

// ---- Score ----------------------------------------------------------------------

test('the computed score must equal the reported score', () => {
  assert.deepEqual(run((c) => { c.K41 = '10'; c.M41 = '9'; }).errors, ['Games say 9-10, sheet says 10-9']);
  assert.deepEqual(run((c) => delete c.M41).errors, ['Reported right score (M41) is blank']);
});

test('equal scores fail', () => {
  const v = run((c) => { clearRow(c, 39); c.M41 = '9'; });
  assert.deepEqual(v.errors, ['No winner: 9-9. If a 9-9 tie was replayed, leave the tied game off and record only the replay']);
});

test('a winner without 10 is a warning, not an error', () => {
  const v = run((c) => { clearRow(c, 37); clearRow(c, 39); c.K41 = '9'; c.M41 = '8'; });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['Phoenix won 9-8, not 10']);
  assert.ok(v.plan);
});

// ---- Decks ------------------------------------------------------------------------

test('decks match ignoring case and spacing, inactive decks included, so they are not new', () => {
  const v = run((c) => (c.G21 = 'mega  lucario EX lucario'), (db) => (db.decks = deckRows(FIXTURE_DECKS, 'FALSE')));
  assert.deepEqual(v.warnings, []);
  assert.equal(v.plan!.games[0].deckLeft, 'mega lucario EX lucario', 'the plan keeps the deck as typed; the save resolves it');
});

test('a typo or a reversed name is a new deck, added as typed, once', () => {
  const v = run((c) => { c.G21 = 'Mega Lucario Exx'; c.G22 = 'mega lucario exx'; c.N22 = 'Lucario Mega Lucario ex'; });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['New deck: Mega Lucario Exx', 'New deck: Lucario Mega Lucario ex']);
  assert.equal(v.plan!.games[1].deckLeft, 'mega lucario exx');
});

// ---- Hash and echoed text ------------------------------------------------------------

test('the hash is stable for the same data and for formatting-only changes', () => {
  const base = run().hash;
  assert.equal(run().hash, base);
  const formatted = run((c) => { c.G21 = '  mega lucario EX  lucario '; c.C22 = 'left player 01'; c.L21 = 'x'; c.F11 = 'PHOENIX'; });
  assert.deepEqual(formatted.errors, []);
  assert.equal(formatted.hash, base);
});

test('the hash changes with any data change', () => {
  const base = run().hash;
  const changed = [
    run((c) => setRow(c, 31, 'DQL (W)', 'DQW (W)')).hash,
    run((c) => (c.AO2 = '2')).hash,
    run((c) => (c.N21 = 'Hoopa Ex Mega Absol EX')).hash,
    run((c) => (c.G21 = 'Brand New Deck')).hash,
    run((c) => { c.AK2 = 'G025'; c.AL2 = 'G022'; }).hash,
  ];
  for (const h of changed) assert.notEqual(h, base);
  assert.equal(new Set(changed).size, changed.length);
});

test('a cell containing @everyone or a role mention does not ping, and long text is capped', () => {
  const v = run((c) => (c.R25 = '@everyone <@&123456789012345678> and a very long name that goes on'));
  const line = v.errors[0];
  assert.ok(!line.includes('@everyone'));
  assert.ok(!line.includes('<@&'));
  const echoed = /^Row 25: (.*) isn't in/.exec(line)![1];
  assert.ok(echoed.replace(/\\|​/g, '').length <= 40, echoed);
  assert.ok(echoed.endsWith('…'));
});

// ---- No Trainer (//) -----------------------------------------------------------

// Row 31 as a DQ given before the game: no Trainer on either side, as on a
// sheet where one gym didn't submit decks in time.
const forfeitRow = (c: MatchCells, row = 31) => {
  c[`C${row}`] = '//';
  c[`G${row}`] = '//';
  c[`N${row}`] = 'Deck Not Submitted In Time';
  c[`R${row}`] = '//';
};

test('a // Trainer row with DQ results scores, saves with no Trainer or deck, and is one warning', () => {
  const v = run(forfeitRow);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, ['Row 31: no Trainer (//), saved as a DQ game with no Trainer or deck']);
  assert.deepEqual(v.plan!.score, { left: 9, right: 10 });
  assert.deepEqual(v.plan!.games[10], {
    trainerLeft: '', deckLeft: '', resultLeft: 'DQL', resultRight: 'DQW', deckRight: '', trainerRight: '',
  });
});

test('// rows are not subs, need no deck, and several share one warning', () => {
  const v = run((c) => {
    forfeitRow(c);
    delete c.G31;
    delete c.N31;
    c.C31 = 'Left Player 03';
  });
  assert.deepEqual(v.errors, ['Row 31: left deck blank'], 'only the // side may leave its deck blank');
  const two = run((c) => {
    forfeitRow(c);
    delete c.N31;
    forfeitRow(c, 30);
    c.K30 = 'DQW';
    c.M30 = 'DQL';
  });
  assert.deepEqual(two.errors, []);
  assert.deepEqual(two.warnings, ['Rows 30 and 31: no Trainer (//), saved as DQ games with no Trainer or deck']);
});

test('a // Trainer row needs DQW and DQL results', () => {
  const v = run((c) => {
    forfeitRow(c);
    setRow(c, 31, 'L', 'W');
  });
  assert.deepEqual(v.errors, ['Row 31: a // Trainer needs DQW and DQL results']);
});
