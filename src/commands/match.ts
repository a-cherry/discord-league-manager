// /match submit and its Save and Cancel buttons (Match Ingestion Plan:
// "Command and flow"). Staff only, in #bot-ops (DISCORD_STAFF_CHANNEL_ID).
//
// The bot reads the tab, validates it against the League DB, and then:
//   failures       a public list in #bot-ops, and a pointer to it for the submitter
//   warnings only  a public list in #bot-ops with Save and Cancel
//   clean          saves at once and replies to the submitter
// Save re-reads and re-validates the tab and saves only if the hash of the
// normalized data still matches the one in its custom_id, so nothing about a
// pending Save is kept in memory and the buttons work after a restart.
import { postMessage, type ActionRow, type Member } from '../discord.js';
import { serviceAccountEmail } from '../google.js';
import type { CommandHandler, ComponentHandler, ComponentInteraction } from '../interactions.js';
import { announceResult } from '../match/announce.js';
import {
  cancelButtonId, echo, escapeMarkdown, issueList, parseSaveButtonId, recordPost, saveButtonId, weekLabel,
  type GymScore,
} from '../match/format.js';
import { checkSentinels, parseMatch, type Side } from '../match/parse.js';
import { SavePending, saveMatch, type SaveResult } from '../match/save.js';
import { crashPoint, type CrashPoint } from '../roster/approval.js';
import {
  SheetAccessError, TabNotFound, parseSheetLink, readMatchTab, type MatchTab, type SheetLink,
} from '../match/sheet-reader.js';
import { sheetsMatchStore, type MatchStore } from '../match/store.js';
import { validate, type LeagueSnapshot, type Validation } from '../match/validate.js';
import { isStaff } from '../roster/approval.js';
import { rebuildViews } from '../views.js';

export const matchCommand = {
  name: 'match',
  description: 'Match sheets (staff only)',
  type: 1,
  options: [
    {
      type: 1,
      name: 'submit',
      description: 'Check and save one match tab',
      options: [
        {
          type: 3, name: 'sheet', required: true, max_length: 500,
          description: 'Link to the match tab, copied from the address bar with the tab open',
        },
      ],
    },
  ],
};

// Everything with I/O, so tests can swap it.
export interface MatchDeps {
  isStaff: (member: Member) => boolean;
  opsChannelId: () => string;
  readTab: (link: SheetLink) => Promise<MatchTab>;
  store: MatchStore;
  // A public post in #bot-ops.
  postOps: (text: string, components?: ActionRow[]) => Promise<void>;
  announce: (guildId: string, left: GymScore, right: GymScore) => Promise<void>;
  rebuildViews: () => Promise<void>;
  serviceAccountEmail: () => string;
  sequenceRules: () => 'fail' | 'warn';
  log: (message: string, err: unknown) => void;
  crash?: (point: CrashPoint) => void;
}

function opsChannelId(): string {
  const id = process.env.DISCORD_STAFF_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_STAFF_CHANNEL_ID is not set');
  return id;
}

export const realMatchDeps: MatchDeps = {
  isStaff,
  opsChannelId,
  readTab: readMatchTab,
  store: sheetsMatchStore,
  postOps: async (text, components) => { await postMessage(opsChannelId(), text, components); },
  announce: (guildId, left, right) => announceResult(guildId, left, right),
  rebuildViews,
  serviceAccountEmail,
  sequenceRules: () => (process.env.GGB_SEQUENCE_RULES === 'warn' ? 'warn' : 'fail'),
  log: (message, err) => console.error(message, err),
  crash: crashPoint,
};

// The warnings post leaves room for what Save adds under it: "Saved by",
// and the record, which with two 90-character gym names and a score change
// runs to about 600 characters.
export const WARNINGS_BUDGET = 1400;

type Checked =
  | { kind: 'reply'; reply: string }
  | { kind: 'checked'; tab: MatchTab; snapshot: LeagueSnapshot; validation: Validation };

interface Saver {
  guildId: string;
  userId: string;
}

// A save, or why there wasn't one: what the submitter is told, and the line
// added under a warnings post.
type Outcome =
  | { saved: Extract<SaveResult, { kind: 'saved' }> }
  | { saved?: undefined; reply: string; line: string };

export function matchHandlers(d: MatchDeps) {
  // Reads and validates the tab. Problems with the link, the workbook or the
  // layout come back as a reply for the submitter alone.
  async function check(link: SheetLink): Promise<Checked> {
    let tab: MatchTab;
    try {
      tab = await d.readTab(link);
    } catch (err) {
      if (err instanceof SheetAccessError) {
        return {
          kind: 'reply',
          reply: `I can't open that workbook. Share it with ${d.serviceAccountEmail()} (Viewer is enough), then submit again.`,
        };
      }
      if (err instanceof TabNotFound) {
        return { kind: 'reply', reply: `That workbook has no tab with gid ${err.gid}. Copy the link from the match tab itself.` };
      }
      throw err;
    }
    const moved = checkSentinels(tab.cells);
    if (moved.length) {
      return {
        kind: 'reply',
        reply: [
          `Tab ${echo(tab.title)} isn't a match tab, or its layout has moved, so nothing was checked:`,
          ...moved.slice(0, 5).map((m) => echo(m, 80)),
        ].join('\n'),
      };
    }
    const snapshot = await d.store.snapshot();
    const validation = validate(parseMatch(tab.title, tab.cells), snapshot, { sequenceRules: d.sequenceRules() });
    return { kind: 'checked', tab, snapshot, validation };
  }

  // Saves a sheet that passed, as `saver`, and words the outcome.
  async function save(saver: Saver, link: SheetLink, c: Extract<Checked, { kind: 'checked' }>): Promise<Outcome> {
    const plan = c.validation.plan!;
    const gym = (side: Side) => {
      const id = side === 'left' ? plan.identity.gymLeftId : plan.identity.gymRightId;
      const g = c.snapshot.gyms.find((r) => r.values.gym_id === id)!.values;
      return { name: g.name, emote: g.emote };
    };
    const gyms = { left: gym('left'), right: gym('right') };
    const matchLine = `${weekLabel(plan.identity.stage, plan.identity.week, true)}: ${escapeMarkdown(gyms.left.name)} vs ${escapeMarkdown(gyms.right.name)}`;

    let result: SaveResult;
    try {
      result = await saveMatch(
        { plan, spreadsheetId: link.spreadsheetId, gid: link.gid, submittedBy: saver.userId, gyms },
        {
          store: d.store,
          rebuildViews: d.rebuildViews,
          announce: (left, right) => d.announce(saver.guildId, left, right),
          log: d.log,
        },
      );
    } catch (err) {
      if (!(err instanceof SavePending)) throw err;
      d.log(`${err.matchId}: save stopped partway`, err.cause);
      try {
        await d.postOps(`**${err.matchId} is pending.** The save of ${matchLine} stopped partway. Submit tab ${echo(c.tab.title)} again to finish it.`);
      } catch (postErr) {
        d.log(`${err.matchId}: the pending notice failed to post`, postErr);
      }
      return {
        reply: `The save stopped partway, so ${err.matchId} is pending. Submit the tab again to finish it.`,
        line: `The save stopped partway; ${err.matchId} is pending. Submit the tab again.`,
      };
    }

    if (result.kind === 'week-full') {
      const { season, stage, week } = plan.identity;
      const why = `S${season} ${stage} W${week} already has ${result.count} matches, so nothing was saved. Check the season, stage and week cells.`;
      return { reply: why, line: `Not saved: ${why}` };
    }
    if (result.kind === 'duplicate') {
      const why = `Matches has ${result.matchIds.length} rows for ${matchLine} (${result.matchIds.join(', ')}), so nothing was saved. Remove the extra row by hand.`;
      return { reply: why, line: `Not saved: ${why}` };
    }
    return { saved: result };
  }

  // Step 9 of the save: whether the record can go out. A failure is logged and
  // the save stays complete.
  function recordAllowed(matchId: string): boolean {
    try {
      d.crash?.('match.log');
      return true;
    } catch (err) {
      d.log(`${matchId}: the #bot-ops record post failed`, err);
      return false;
    }
  }

  const handleMatch: CommandHandler = async (interaction) => {
    const sub = interaction.data.options?.[0];
    if (sub?.name !== 'submit') return `Unknown subcommand: ${sub?.name}`;
    if (!d.isStaff(interaction.member)) return 'Only staff can submit match sheets.';
    const ops = d.opsChannelId();
    if (interaction.channel_id !== ops) return `Run /match submit in <#${ops}>.`;

    const raw = String(sub.options?.find((o) => o.name === 'sheet')?.value ?? '');
    const { spreadsheetId, gid } = parseSheetLink(raw);
    if (!spreadsheetId) return "That isn't a link to a Google Sheet.";
    if (!gid) {
      return "That link doesn't say which tab to read (it has no #gid=). Open the match tab, copy the link from the address bar, and submit again.";
    }
    const link = { spreadsheetId, gid };

    const c = await check(link);
    if (c.kind === 'reply') return c.reply;
    const { errors, warnings, hash } = c.validation;
    const title = echo(c.tab.title);

    if (errors.length) {
      const list = issueList(c.tab.title, 'problem', errors);
      try {
        await d.postOps(list);
      } catch (err) {
        d.log('the failure list failed to post in #bot-ops', err);
        return list;
      }
      return `Tab ${title} has ${errors.length === 1 ? 'a problem' : `${errors.length} problems`}, listed in <#${ops}>. Nothing was saved.`;
    }

    if (warnings.length) {
      const list = issueList(c.tab.title, 'warning', warnings, WARNINGS_BUDGET);
      const buttons: ActionRow[] = [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Save', custom_id: saveButtonId(spreadsheetId, gid, hash!) },
          { type: 2, style: 2, label: 'Cancel', custom_id: cancelButtonId(hash!) },
        ],
      }];
      try {
        await d.postOps(list, buttons);
      } catch (err) {
        d.log('the warnings failed to post in #bot-ops', err);
        return { reply: list, components: buttons };
      }
      return `Tab ${title} has ${warnings.length === 1 ? 'a warning' : `${warnings.length} warnings`}. Save or Cancel on the post in <#${ops}>.`;
    }

    // A clean sheet: the record is its own post, naming who submitted it, and
    // the submitter's reply only points at it.
    const userId = interaction.member.user.id;
    const out = await save({ guildId: interaction.guild_id, userId }, link, c);
    if (!out.saved) return out.reply;
    const record = recordPost({ ...out.saved, submittedBy: userId });
    if (!recordAllowed(out.saved.matchId)) return record;
    try {
      await d.postOps(record);
    } catch (err) {
      d.log(`${out.saved.matchId}: the #bot-ops record post failed`, err);
      return record;
    }
    return `Saved as ${out.saved.matchId}. The record is in <#${ops}>.`;
  };

  // Save on a warnings post. The buttons are already gone (see server.ts);
  // a result with only a reply puts them back.
  const handleSave: ComponentHandler = async (interaction: ComponentInteraction) => {
    if (!d.isStaff(interaction.member)) return { reply: 'Only staff can save match sheets.' };
    const ids = parseSaveButtonId(interaction.data.custom_id);
    if (!ids) return { message: `${interaction.message.content}\nThis Save button can't be read. Submit the tab again.` };
    const link = { spreadsheetId: ids.spreadsheetId, gid: ids.gid };
    const c = await check(link);
    if (c.kind === 'reply') return { reply: c.reply };
    const base = interaction.message.content;
    if (c.validation.errors.length) {
      return { message: `${issueList(c.tab.title, 'problem', c.validation.errors, WARNINGS_BUDGET)}\nThe sheet now fails, so nothing was saved.` };
    }
    if (c.validation.hash !== ids.hash) {
      return { message: `${base}\nThe sheet changed after these warnings, so nothing was saved. Submit the tab again.` };
    }
    // The record goes under the warnings, after who saved it; no separate post
    // and no private reply, which would only repeat it.
    const userId = interaction.member.user.id;
    const out = await save({ guildId: interaction.guild_id, userId }, link, c);
    if (!out.saved) return { message: `${base}\n${out.line}` };
    const saved = `${base}\nSaved by <@${userId}>`;
    if (!recordAllowed(out.saved.matchId)) return { message: saved };
    return { message: `${saved}\n---\n${recordPost(out.saved)}` };
  };

  const handleCancel: ComponentHandler = async (interaction) => {
    if (!d.isStaff(interaction.member)) return { reply: 'Only staff can cancel match sheets.' };
    return { message: `${interaction.message.content}\nCancelled by <@${interaction.member.user.id}>. Nothing was saved.` };
  };

  return { handleMatch, handleSave, handleCancel };
}

const real = matchHandlers(realMatchDeps);
export const handleMatch = real.handleMatch;
export const handleMatchSave = real.handleSave;
export const handleMatchCancel = real.handleCancel;

// Shown in place of the Save and Cancel buttons while a press is worked on.
export const MATCH_SAVING = '⏳ Checking the sheet and saving…';
