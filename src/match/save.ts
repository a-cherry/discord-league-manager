// The match save sequence (plan: "Save, locking and failure handling").
//
// Under withLock('match') the bot re-reads Matches, Decks, Games and Match
// rosters and decides there: new match or replace, the next match_id, and the
// week cap. Then, in order:
//   1. append new decks             match.decks
//   2. Matches row pending          match.pending
//   3. delete old Games and rosters match.delete
//   4. append Match rosters         match.rosters
//   5. append Games                 match.games
//   6. Matches row complete         match.finalize
//   7. rebuild views                match.views
// and after the lock:
//   8. announce, if the rule says   match.announce
// The caller then posts the #bot-ops record (step 9, match.log), since where
// it goes depends on whether the save came from a warnings post.
// The status column is the crash safety: until step 6 the match is pending
// and views ignore it; a re-submit finds it by identity and replays 3 to 6.
// Each crash point runs right after its step's write, so GGB_CRASH_AT stops
// the bot with that write landed, and GGB_FAIL_AT fails as if the call had
// errored after landing. For 7 and 8 it runs before the call.
import { withLock } from '../locks.js';
import { crashPoint, type CrashPoint } from '../roster/approval.js';
import type { RowInput, SheetRow } from '../sheet-rows.js';
import { type AnnouncementOutcome, type GymScore, type PriorMatch, type SavedMatch, shouldAnnounce } from './format.js';
import { deckKey, type Side } from './parse.js';
import type { MatchStore } from './store.js';
import { type SavePlan, sameMatch } from './validate.js';

export interface SaveInput {
  plan: SavePlan;
  spreadsheetId: string;
  gid: string;
  submittedBy: string; // discord_id of whoever completed the save
  gyms: Record<Side, { name: string; emote: string }>;
}

export interface SaveDeps {
  store: MatchStore;
  rebuildViews: () => Promise<void>;
  // Posts the results embed, winner first; left and right as on the sheet.
  announce: (left: GymScore, right: GymScore) => Promise<void>;
  crash?: (point: CrashPoint) => void;
  now?: () => Date;
  lockWaitMs?: number;
  log?: (message: string, err: unknown) => void;
}

export type SaveResult =
  | (SavedMatch & { kind: 'saved'; announcement: AnnouncementOutcome; viewsFailed: boolean; prior?: PriorMatch })
  | { kind: 'week-full'; count: number }
  | { kind: 'duplicate'; matchIds: string[] };

// A failure after the Matches row went pending (steps 2 to 6). Staff submit
// the tab again; that finds the pending row and finishes under the same ID.
export class SavePending extends Error {
  constructor(readonly matchId: string, readonly cause: unknown) {
    super(`${matchId} was left pending: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export const tabLink = (spreadsheetId: string, gid: string) =>
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`;

// One after the highest M#### in Matches, M0001 for the first.
export function nextMatchId(matches: SheetRow<'matches'>[]): string {
  const highest = Math.max(0, ...matches.map((m) => /^M(\d+)$/.exec(m.values.match_id)?.[1]).filter(Boolean).map(Number));
  return `M${String(highest + 1).padStart(4, '0')}`;
}

const toPrior = (m: SheetRow<'matches'>['values']): PriorMatch => ({
  status: m.status, gymLeftId: m.gym_left_id, gymRightId: m.gym_right_id, scoreLeft: m.score_left, scoreRight: m.score_right,
});

export async function saveMatch(input: SaveInput, deps: SaveDeps): Promise<SaveResult> {
  const crash = deps.crash ?? crashPoint;
  const log = deps.log ?? ((message, err) => console.error(message, err));
  const locked = await withLock('match', () => saveLocked(input, deps, crash, log), deps.lockWaitMs);
  if (locked.kind !== 'locked') return locked;

  const { saved, prior } = locked;
  const { left, right } = saved;
  let announcement: AnnouncementOutcome = 'unchanged';
  if (shouldAnnounce(prior, left, right)) {
    try {
      crash('match.announce');
      await deps.announce(left, right);
      announcement = 'posted';
    } catch (err) {
      log(`${saved.matchId}: the results announcement failed`, err);
      announcement = 'failed';
    }
  }
  return { kind: 'saved', ...saved, prior, announcement, viewsFailed: locked.viewsFailed };
}

type Locked =
  | { kind: 'locked'; saved: SavedMatch; prior?: PriorMatch; viewsFailed: boolean }
  | Exclude<SaveResult, { kind: 'saved' }>;

async function saveLocked(
  input: SaveInput, deps: SaveDeps, crash: (p: CrashPoint) => void, log: NonNullable<SaveDeps['log']>,
): Promise<Locked> {
  const { plan, gyms } = input;
  const { identity } = plan;
  const { store } = deps;
  const state = await store.readForSave();

  // Decided here, not at validation: another save may have landed since.
  const same = state.matches.filter((m) => sameMatch(m.values, identity));
  if (same.length > 1) return { kind: 'duplicate', matchIds: same.map((m) => m.values.match_id) };
  const existing = same[0];
  const sameWeek = (m: SheetRow<'matches'>) =>
    m.values.status === 'complete' && Number(m.values.season) === identity.season &&
    m.values.stage === identity.stage && Number(m.values.week) === identity.week;
  const others = state.matches.filter((m) => sameWeek(m) && m !== existing).length;
  if (others >= plan.weekCap) return { kind: 'week-full', count: others };

  // Decks matched again against the fresh tab, so a deck another save just
  // added is used under its spelling instead of being added twice.
  const known = new Map(state.decks.map((d) => [deckKey(d.values.name), d.values.name]));
  const newDecks: string[] = [];
  const deck = (typed: string) => {
    const key = deckKey(typed);
    if (!known.has(key)) {
      known.set(key, typed);
      newDecks.push(typed);
    }
    return known.get(key)!;
  };
  const games = plan.games.map((g) => ({ ...g, deckLeft: deck(g.deckLeft), deckRight: deck(g.deckRight) }));

  // 1. Decks. A failure here leaves at most some decks, which the next submit matches.
  if (newDecks.length) await store.appendDecks(newDecks);
  crash('match.decks');

  const matchId = existing?.values.match_id ?? nextMatchId(state.matches);
  const prior = existing ? toPrior(existing.values) : undefined;
  const row: RowInput<'matches'> = {
    match_id: matchId,
    season: identity.season,
    stage: identity.stage,
    week: identity.week,
    gym_left_id: identity.gymLeftId,
    gym_right_id: identity.gymRightId,
    score_left: '',
    score_right: '',
    status: 'pending',
    tab_link: '',
    submitted_by: '',
    submitted_at: '',
  };

  try {
    // 2. Pending.
    let rowNumber: number;
    if (existing) {
      rowNumber = existing.rowNumber;
      await store.setMatchStatus(rowNumber, 'pending');
    } else {
      rowNumber = await store.appendMatch(row);
    }
    crash('match.pending');

    // 3. Delete this match's old rows: all of them, so a duplicate from an
    // append that landed twice goes too.
    await store.deleteMatchRows({
      games: state.games.filter((g) => g.values.match_id === matchId).map((g) => g.rowNumber),
      rosters: state.rosters.filter((r) => r.values.match_id === matchId).map((r) => r.rowNumber),
    });
    crash('match.delete');

    // 4. Match rosters, one row per distinct Trainer on each side.
    const sides: [Side, string][] = [['left', identity.gymLeftId], ['right', identity.gymRightId]];
    await store.appendRosters(
      sides.flatMap(([side, gymId]) => plan.rosters[side].map((discordId) => ({ match_id: matchId, gym_id: gymId, discord_id: discordId }))),
    );
    crash('match.rosters');

    // 5. Games, in sheet order.
    await store.appendGames(
      games.map((g, i) => ({
        match_id: matchId, game_number: i + 1, trainer_left: g.trainerLeft, deck_left: g.deckLeft,
        result_left: g.resultLeft, result_right: g.resultRight, deck_right: g.deckRight, trainer_right: g.trainerRight,
      })),
    );
    crash('match.games');

    // 6. Complete, with the scores and who saved it.
    await store.finalizeMatch(rowNumber, {
      ...row,
      score_left: plan.score.left,
      score_right: plan.score.right,
      status: 'complete',
      tab_link: tabLink(input.spreadsheetId, input.gid),
      submitted_by: input.submittedBy,
      submitted_at: (deps.now?.() ?? new Date()).toISOString(),
    });
    crash('match.finalize');
  } catch (err) {
    throw new SavePending(matchId, err);
  }

  // 7. Views. A failure is logged; the match is already complete.
  let viewsFailed = false;
  try {
    crash('match.views');
    await deps.rebuildViews();
  } catch (err) {
    log(`${matchId}: rebuilding the views failed`, err);
    viewsFailed = true;
  }

  const score = (side: Side, gymId: string): GymScore => ({ gymId, ...gyms[side], score: plan.score[side] });
  return {
    kind: 'locked',
    prior,
    viewsFailed,
    saved: {
      matchId,
      replaced: Boolean(existing),
      stage: identity.stage,
      week: identity.week,
      left: score('left', identity.gymLeftId),
      right: score('right', identity.gymRightId),
      weekCount: others + 1,
    },
  };
}
