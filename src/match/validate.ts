// Validation of a parsed match tab against a League DB snapshot, and the hash
// the Save button compares. Pure: no Sheets or Discord imports.
//
// Every check runs and every failure is reported; any error blocks the save.
// The checks are the plan's Validation table plus the Bot Spec's sequence
// rules (second loss, repeats, repeat after a first-game loss).
import { createHash } from 'node:crypto';
import type { SheetRow } from '../sheet-rows.js';
import { echo } from './format.js';
import {
  type GameField, type GameRow, type ParsedMatch, type Result, type Side,
  GAME_FIELDS, SIDES, deckKey, isErrorValue, isSequenceLoss, parseResult, resultsPair, scoresPoint,
} from './parse.js';

export interface LeagueSnapshot {
  gyms: SheetRow<'gyms'>[];
  trainers: SheetRow<'trainers'>[];
  seasons: SheetRow<'seasons'>[];
  matches: SheetRow<'matches'>[];
  decks: SheetRow<'decks'>[];
}

export interface ValidateOptions {
  // GGB_SEQUENCE_RULES: 'warn' turns the three sequence rules into warnings.
  sequenceRules?: 'fail' | 'warn';
}

export const STAGES = ['Regular', 'Playoff', 'Playout'] as const;

export interface MatchIdentity {
  season: number;
  stage: string;
  week: number;
  gymLeftId: string;
  gymRightId: string;
}

export interface PlannedGame {
  trainerLeft: string; // discord_id
  deckLeft: string; // the Decks spelling, or as typed for a new deck
  resultLeft: string; // as written on the sheet
  resultRight: string;
  deckRight: string;
  trainerRight: string;
}

// What a save writes, decided from this snapshot. Advisory: the save re-reads
// Matches and Decks inside the lock.
export interface SavePlan {
  identity: MatchIdentity;
  existingMatchId?: string;
  rosters: Record<Side, string[]>; // distinct discord_ids in slot order
  games: PlannedGame[];
  newDecks: string[];
  score: Record<Side, number>;
  weekCap: number; // half the active gyms; the save checks it again inside the lock
}

export interface Validation {
  errors: string[];
  warnings: string[];
  plan?: SavePlan; // only when there are no errors
  hash?: string;
}

const SIDE_LABEL: Record<Side, string> = { left: 'Left', right: 'Right' };
const FIELD_LABEL: Record<GameField, string> = {
  trainerLeft: 'left Trainer', deckLeft: 'left deck', resultLeft: 'left result',
  resultRight: 'right result', deckRight: 'right deck', trainerRight: 'right Trainer',
};
const FIELDS: Record<Side, { trainer: GameField; deck: GameField; result: GameField }> = {
  left: { trainer: 'trainerLeft', deck: 'deckLeft', result: 'resultLeft' },
  right: { trainer: 'trainerRight', deck: 'deckRight', result: 'resultRight' },
};

const isCanonicalInt = (s: string) => /^[1-9]\d*$/.test(s);
const isActive = (v: string) => v.trim().toLowerCase() === 'true';
// Match identity: season, stage, week and the pair of gyms in either order.
export const sameMatch = (m: SheetRow<'matches'>['values'], id: MatchIdentity) =>
  Number(m.season) === id.season && m.stage === id.stage && Number(m.week) === id.week &&
  ((m.gym_left_id === id.gymLeftId && m.gym_right_id === id.gymRightId) ||
    (m.gym_left_id === id.gymRightId && m.gym_right_id === id.gymLeftId));

// A game row that passed its row checks, with each side resolved.
interface CheckedGame {
  game: GameRow;
  sides: Record<Side, { name: string; discordId?: string; deck: string; result: Result }>;
}

export function validate(match: ParsedMatch, db: LeagueSnapshot, options: ValidateOptions = {}): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sequence = options.sequenceRules === 'warn' ? warnings : errors;

  // ---- Season, stage, week
  const config = match.config;
  const configOk = { season: false, stage: false, week: false };
  for (const [field, label] of [['season', 'Season'], ['week', 'Week']] as const) {
    const v = config[field];
    if (!v) errors.push(`${label} is blank`);
    else if (isErrorValue(v)) errors.push(`${label} cell shows ${v}`);
    else if (!isCanonicalInt(v)) errors.push(`${label} "${echo(v)}" is not a whole number`);
    else configOk[field] = true;
  }
  if (!config.stage) errors.push('Stage is blank');
  else if (isErrorValue(config.stage)) errors.push(`Stage cell shows ${config.stage}`);
  else if (!(STAGES as readonly string[]).includes(config.stage)) {
    errors.push(`Stage "${echo(config.stage)}" must be Regular, Playoff or Playout`);
  } else configOk.stage = true;

  const active = db.seasons.filter((s) => isActive(s.values.active));
  if (!active.length) errors.push('No season is active in the League DB');
  else if (active.length > 1) errors.push(`The League DB has ${active.length} active seasons`);
  else if (configOk.season && Number(config.season) !== Number(active[0].values.season)) {
    errors.push(`Season ${config.season} is not the active season (${Number(active[0].values.season)})`);
  }

  // ---- Gyms
  const gyms = new Map(db.gyms.map((g) => [g.values.gym_id, g.values]));
  const gymName = (side: Side) => gyms.get(match.gymIds[side])?.name ?? `${SIDE_LABEL[side]} gym`;
  let gymsOk = true;
  for (const side of SIDES) {
    const id = match.gymIds[side];
    const gym = gyms.get(id);
    const fail = (msg: string) => { errors.push(msg); gymsOk = false; };
    if (!id) fail(`${SIDE_LABEL[side]} gym is blank`);
    else if (isErrorValue(id)) fail(`${SIDE_LABEL[side]} gym cell shows ${id}`);
    else if (!gym) fail(`${SIDE_LABEL[side]} gym ${echo(id)} is not a gym`);
    else if (gym.status !== 'active') fail(`${SIDE_LABEL[side]} gym ${echo(gym.name)} is ${echo(gym.status)}`);
  }
  if (gymsOk && match.gymIds.left === match.gymIds.right) {
    errors.push(`Both sides are the same gym, ${echo(gymName('left'))}`);
    gymsOk = false;
  }

  // ---- Identity and the week cap
  let identity: MatchIdentity | undefined;
  let existingMatchId: string | undefined;
  const weekCap = Math.floor(db.gyms.filter((g) => g.values.status === 'active').length / 2);
  if (configOk.season && configOk.stage && configOk.week && gymsOk) {
    identity = {
      season: Number(config.season), stage: config.stage, week: Number(config.week),
      gymLeftId: match.gymIds.left, gymRightId: match.gymIds.right,
    };
    const id = identity;
    existingMatchId = db.matches.find((m) => sameMatch(m.values, id))?.values.match_id;
    const others = db.matches.filter(
      (m) => m.values.status === 'complete' && !sameMatch(m.values, id) &&
        Number(m.values.season) === id.season && m.values.stage === id.stage && Number(m.values.week) === id.week,
    ).length;
    if (others >= weekCap) {
      errors.push(`S${id.season} ${id.stage} W${id.week} already has ${others} matches. Check the season, stage and week cells`);
    }
  }

  // ---- Rosters
  const trainerIds = new Set(db.trainers.map((t) => t.values.discord_id));
  const rosters: Record<Side, string[]> = { left: [], right: [] };
  // Game names resolve against AO names on the same side; the first match wins.
  const nameTable: Record<Side, Map<string, string | undefined>> = { left: new Map(), right: new Map() };
  for (const side of SIDES) {
    const filled = match.slots[side].filter((s) => s.name);
    const distinct = new Set(filled.map((s) => s.name.toLowerCase()));
    if (distinct.size < 3) errors.push(`${echo(gymName(side))} lists ${distinct.size} Trainer${distinct.size === 1 ? '' : 's'}`);
    for (const s of filled) {
      const where = `${SIDE_LABEL[side]} roster slot ${s.slot}`;
      const id = s.discordId;
      let resolved: string | undefined;
      if (!id || id.toUpperCase() === 'NOT FOUND' || isErrorValue(id)) errors.push(`${where}: ${echo(s.name)} not found`);
      else if (!/^\d{17,19}$/.test(id)) errors.push(`${where}: ${echo(s.name)} has an unreadable Discord ID`);
      else if (!trainerIds.has(id)) errors.push(`${where}: ${echo(s.name)} is not in the League DB`);
      else resolved = id;
      if (resolved && !rosters[side].includes(resolved)) rosters[side].push(resolved);
    }
    for (const s of match.slots[side]) {
      const key = s.tableName.toLowerCase();
      if (s.tableName && !nameTable[side].has(key)) {
        nameTable[side].set(key, /^\d{17,19}$/.test(s.discordId) && trainerIds.has(s.discordId) ? s.discordId : undefined);
      }
    }
  }

  // ---- Mid-match subs
  const subs = findSubs(match, db, nameTable, rosters, gymName, errors);
  for (const side of SIDES) {
    for (const sub of subs[side]) {
      // Known from here on, so the sub's rows pass the roster check. A failed
      // sub has its one error already and resolves to no ID.
      nameTable[side].set(sub.key, sub.discordId);
      if (sub.discordId) {
        rosters[side].push(sub.discordId);
        warnings.push(`Row ${sub.firstRow}: ${echo(sub.name)} subbed in for ${echo(sub.replacedName)}`);
      }
    }
  }

  // ---- Game rows
  if (!match.games.length) errors.push('No games recorded');
  const checked: CheckedGame[] = [];
  let gamesOk = true;
  for (const game of match.games) {
    const rowErrors: string[] = [];
    const broken = GAME_FIELDS.filter((f) => isErrorValue(game[f]));
    for (const f of broken) rowErrors.push(`Row ${game.row}: ${FIELD_LABEL[f]} shows ${game[f]}`);
    const blank = GAME_FIELDS.filter((f) => !game[f]);
    if (blank.length) rowErrors.push(`Row ${game.row}: ${joinAnd(blank.map((f) => FIELD_LABEL[f]))} blank`);

    const results = {} as Record<Side, Result | undefined>;
    for (const side of SIDES) {
      const text = game[FIELDS[side].result];
      if (!text || isErrorValue(text)) continue;
      results[side] = parseResult(text);
      if (!results[side]) rowErrors.push(`Row ${game.row}: ${side} result "${echo(text)}" is not recognized`);
    }
    if (results.left && results.right && !resultsPair(results.left, results.right)) {
      const [l, r] = [game.resultLeft.toUpperCase(), game.resultRight.toUpperCase()];
      rowErrors.push(l === r ? `Row ${game.row}: both sides ${echo(l)}` : `Row ${game.row}: results ${echo(l)} and ${echo(r)} don't pair`);
    }

    for (const side of SIDES) {
      const name = game[FIELDS[side].trainer];
      if (name && !isErrorValue(name) && !nameTable[side].has(name.toLowerCase())) {
        rowErrors.push(`Row ${game.row}: ${echo(name)} is not on ${possessive(echo(gymName(side)))} roster`);
      }
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
      gamesOk = false;
      continue;
    }
    checked.push({
      game,
      sides: Object.fromEntries(SIDES.map((side) => [side, {
        name: game[FIELDS[side].trainer],
        discordId: nameTable[side].get(game[FIELDS[side].trainer].toLowerCase()),
        deck: game[FIELDS[side].deck],
        result: results[side]!,
      }])) as CheckedGame['sides'],
    });
  }

  // ---- Sequence rules, per Trainer, over the rows that passed. A sub
  // continues the record of the Trainer they replaced: their losses and
  // repeat are shared. Messages name whoever played the row.
  for (const side of SIDES) {
    const ownKey = (g: CheckedGame) => g.sides[side].discordId ?? `name:${g.sides[side].name.toLowerCase()}`;
    // A sub takes over mid-turn: the Trainer before them hasn't lost twice.
    // Coming in after a second loss is a fresh turn, which needs a roster slot.
    const active = subs[side].filter((s) => {
      if (!s.discordId) return false;
      const lossesBefore = checked.filter(
        (g) => g.game.row < s.firstRow && ownKey(g) === s.replacedKey && isSequenceLoss(g.sides[side].result),
      ).length;
      if (lossesBefore < 2) return true;
      errors.push(
        `Row ${s.firstRow}: ${echo(s.name)} isn't in ${possessive(echo(gymName(side)))} roster slots and came in after ` +
          `${possessive(echo(s.replacedName))} second loss, not mid-turn. Put them in a roster slot`,
      );
      return false; // not a sub, so their record isn't merged
    });
    const subOf = new Map(active.map((s) => [s.key, s]));
    const trainerKey = (g: CheckedGame) => subOf.get(g.sides[side].name.toLowerCase())?.replacedKey ?? ownKey(g);
    const byTrainer = new Map<string, CheckedGame[]>();
    for (const g of checked) byTrainer.set(trainerKey(g), [...(byTrainer.get(trainerKey(g)) ?? []), g]);

    const nameAt = (row: number) => checked.find((g) => g.game.row === row)!.sides[side].name;
    const repeaters: string[] = [];
    for (const games of byTrainer.values()) {
      const r = sequenceCheck(games.map((g) => ({ row: g.game.row, ...g.sides[side] })));
      if (r.afterSecondLoss) {
        const name = nameAt(r.afterSecondLoss.row);
        const shared = active.filter((s) => s.replacedKey === trainerKey(games[0]));
        const record = shared.length
          ? `${joinAnd([shared[0].replacedName, ...shared.map((s) => s.name)].map((n) => echo(n)))} already have`
          : `${echo(name)} already has`;
        sequence.push(`Row ${r.afterSecondLoss.row}: ${record} 2 ${r.afterSecondLoss.tie ? 'losses or ties' : 'losses'}`);
      }
      if (r.repeat) {
        const name = nameAt(r.repeat.row);
        repeaters.push(name);
        if (r.repeat.illegal) {
          const why = r.repeat.illegal === 'tie' ? 'after a tie' : 'after winning with it';
          sequence.push(`Row ${r.repeat.row}: ${echo(name)} repeats ${echo(r.repeat.deck)} ${why}`);
        }
      }
    }
    if (repeaters.length > 2) {
      sequence.push(`${echo(gymName(side))} used ${repeaters.length} repeats: ${repeaters.map((n) => echo(n)).join(', ')}`);
    }
  }

  // ---- Score
  const score: Record<Side, number> = { left: 0, right: 0 };
  for (const g of checked) for (const side of SIDES) if (scoresPoint(g.sides[side].result)) score[side]++;
  const reported = {} as Record<Side, number | undefined>;
  for (const side of SIDES) {
    const v = match.reported[side];
    const cell = side === 'left' ? 'K41' : 'M41';
    if (!v) errors.push(`Reported ${side} score (${cell}) is blank`);
    else if (isErrorValue(v)) errors.push(`Reported ${side} score (${cell}) shows ${v}`);
    else if (!/^\d+$/.test(v)) errors.push(`Reported ${side} score (${cell}) "${echo(v)}" is not a number`);
    else reported[side] = Number(v);
  }
  if (gamesOk && checked.length) {
    if (reported.left !== undefined && reported.right !== undefined &&
        (reported.left !== score.left || reported.right !== score.right)) {
      errors.push(`Games say ${score.left}-${score.right}, sheet says ${reported.left}-${reported.right}`);
    }
    if (score.left === score.right) {
      errors.push(`No winner: ${score.left}-${score.right}. If a 9-9 tie was replayed, leave the tied game off and record only the replay`);
    } else {
      const winner: Side = score.left > score.right ? 'left' : 'right';
      const loser: Side = winner === 'left' ? 'right' : 'left';
      if (score[winner] !== 10) warnings.push(`${echo(gymName(winner))} won ${score[winner]}-${score[loser]}, not 10`);
    }
  }

  // ---- Decks: matched ignoring case and spacing, stored under the existing spelling
  const known = new Map(db.decks.map((d) => [deckKey(d.values.name), d.values.name]));
  const newDecks: string[] = [];
  const deckName = (typed: string) => {
    const key = deckKey(typed);
    if (!known.has(key)) {
      known.set(key, typed);
      newDecks.push(typed);
    }
    return known.get(key)!;
  };
  const games: PlannedGame[] = checked.map((g) => ({
    trainerLeft: g.sides.left.discordId ?? '',
    deckLeft: deckName(g.sides.left.deck),
    resultLeft: g.game.resultLeft,
    resultRight: g.game.resultRight,
    deckRight: deckName(g.sides.right.deck),
    trainerRight: g.sides.right.discordId ?? '',
  }));
  for (const d of newDecks) warnings.push(`New deck: ${echo(d)}`);

  if (errors.length || !identity) return { errors, warnings };
  const plan: SavePlan = { identity, existingMatchId, rosters, games, newDecks, score, weekCap };
  const hash = sheetHash({
    identity,
    rosters,
    games: checked.map((g) => [
      g.sides.left.discordId, deckKey(g.sides.left.deck), g.game.resultLeft,
      g.game.resultRight, deckKey(g.sides.right.deck), g.sides.right.discordId,
    ]),
  });
  return { errors, warnings, plan, hash };
}

// ---- Mid-match subs -----------------------------------------------------------

// The sheet's name to Discord ID table only holds the 5 roster slots. When a
// Trainer leaves mid-match, the sub's games carry the sub's name. Each row is
// credited to whoever played it, and the sub continues the record of the
// Trainer they replaced.

export interface Sub {
  name: string;
  key: string; // lower-cased name
  discordId?: string; // undefined when the sub failed a check (the error is already reported)
  firstRow: number;
  replacedName: string;
  replacedKey: string; // the replaced Trainer's sequence key: their discord_id, or name:<lower name>
}

// Each name on a side's game rows that isn't in that side's roster slots. It
// must be the active Trainer on that gym whose server_nickname matches, which
// is what catches a typo. The sub replaces the rostered Trainer on the row
// just before their first game, and their games must be one unbroken
// stretch. Anything else fails with one line per name. Whether they came in
// mid-turn is checked with the sequence rules.
function findSubs(
  match: ParsedMatch,
  db: LeagueSnapshot,
  nameTable: Record<Side, Map<string, string | undefined>>,
  rosters: Record<Side, string[]>,
  gymName: (side: Side) => string,
  errors: string[],
): Record<Side, Sub[]> {
  const subs: Record<Side, Sub[]> = { left: [], right: [] };
  for (const side of SIDES) {
    const field = FIELDS[side].trainer;
    const played = new Map<string, { name: string; rows: number[] }>();
    for (const g of match.games) {
      const name = g[field];
      if (!name || isErrorValue(name)) continue;
      const key = name.toLowerCase();
      if (!played.has(key)) played.set(key, { name, rows: [] });
      played.get(key)!.rows.push(g.row);
    }
    const gym = echo(gymName(side));
    const claimed = new Set(rosters[side]);

    for (const [key, { name, rows }] of played) {
      if (nameTable[side].has(key)) continue;
      const at = `Row ${rows[0]}: ${echo(name)}`;
      const index = match.games.findIndex((g) => g.row === rows[0]);
      const prev = match.games[index - 1]?.[field] ?? '';
      const sub: Sub = {
        name, key, firstRow: rows[0], replacedName: prev,
        replacedKey: nameTable[side].get(prev.toLowerCase()) ?? `name:${prev.toLowerCase()}`,
      };
      subs[side].push(sub);

      const found = db.trainers.filter(
        (t) => t.values.gym_id === match.gymIds[side] && t.values.status === 'active' &&
          t.values.server_nickname.replace(/\s+/g, ' ').trim().toLowerCase() === key,
      );
      const stretch = match.games.slice(index, index + rows.length).map((g) => g.row);
      if (!found.length) {
        errors.push(`${at} isn't in ${possessive(gym)} roster slots, and no active ${gym} Trainer has that server nickname`);
      } else if (found.length > 1) errors.push(`${at} matches ${found.length} ${gym} Trainers in the League DB`);
      else if (claimed.has(found[0].values.discord_id)) errors.push(`${at} is already on ${possessive(gym)} roster under another name`);
      else if (index === 0 || !nameTable[side].has(prev.toLowerCase())) errors.push(`${at} subbed in with no rostered ${gym} Trainer before them`);
      else if (stretch.join() !== rows.join()) errors.push(`${at} plays in two separate stretches; a sub plays one`);
      else {
        sub.discordId = found[0].values.discord_id;
        claimed.add(sub.discordId);
      }
    }
  }
  return subs;
}

// "Summit's", "Pocket Refs'".
const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

// ---- Sequence rules (Bot Spec, Validation: Repeats and the second-loss rule) --

export interface SequenceGame {
  row: number;
  deck: string;
  result: Result;
}

export interface SequenceResult {
  // The first game played after a second loss or tie.
  afterSecondLoss?: { row: number; tie: boolean };
  // A repeat: the deck eliminated by the first loss or tie, played again later.
  repeat?: { row: number; deck: string; illegal?: 'win' | 'tie' };
}

// One Trainer's games in row order. The games split into two runs at the
// first loss or tie (a DQL of any reason counts as a loss). The second run is
// a repeat when it plays the deck that loss eliminated. A repeat is legal only
// when the first run was a single loss, never after a win or a tie. Rows with
// an (R) reason are repeat misuse, a loss that doesn't use up a repeat, so the
// repeat checks skip them.
export function sequenceCheck(games: SequenceGame[]): SequenceResult {
  const out: SequenceResult = {};
  let losses = 0;
  let tie = false;
  for (const g of games) {
    if (losses >= 2) {
      out.afterSecondLoss = { row: g.row, tie };
      break;
    }
    if (isSequenceLoss(g.result)) {
      losses++;
      if (g.result.kind === 'TIE') tie = true;
    }
  }

  const firstLoss = games.findIndex((g) => isSequenceLoss(g.result));
  if (firstLoss === -1) return out;
  const eliminated = deckKey(games[firstLoss].deck);
  const repeat = games
    .slice(firstLoss + 1)
    .find((g) => g.result.reason !== 'R' && deckKey(g.deck) === eliminated);
  if (repeat) {
    const firstRun = games.slice(0, firstLoss + 1);
    const illegal = firstRun.length > 1 ? 'win' : firstRun[0].result.kind === 'TIE' ? 'tie' : undefined;
    out.repeat = { row: repeat.row, deck: repeat.deck, ...(illegal && { illegal }) };
  }
  return out;
}

// ---- Hash -------------------------------------------------------------------

// JSON with object keys sorted at every level, so equal data hashes equally.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// First 12 hex characters of SHA-256 over what the sheet says: the match
// identity, both rosters' IDs and the game rows, with decks as deckKey(). It
// hashes parsed data, so colors and formatting don't change it. Nothing from
// the League DB beyond the resolved IDs goes in (not the Decks spelling, not
// which decks are new), so a deck another save added since the warnings, or
// a second press of Save, doesn't read as a changed sheet.
export function sheetHash(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex').slice(0, 12);
}
