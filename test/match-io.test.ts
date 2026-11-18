// The match code that talks to Sheets and Discord, against stub clients: the
// sheet reader, the results announcement and the button routing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMatchCancel, handleMatchSave, MATCH_SAVING } from '../src/commands/match.js';
import { handleDisbandButton } from '../src/commands/gym.js';
import { componentRoute } from '../src/components.js';
import type { Embed } from '../src/discord.js';
import { announceResult } from '../src/match/announce.js';
import { cancelButtonId, saveButtonId, type GymScore } from '../src/match/format.js';
import { SheetAccessError, TabNotFound, readMatchTab } from '../src/match/sheet-reader.js';
import { handleDecision } from '../src/roster/approval.js';
import { CARD_PROCESSING } from '../src/roster/requests.js';

// ---- The sheet reader ---------------------------------------------------------

const MATCH_GRID = { rowCount: 1000, columnCount: 50 };
const TABS = [
  { sheetId: 0, title: 'Weekly Setup', gridProperties: MATCH_GRID },
  { sheetId: 777, title: '1', gridProperties: MATCH_GRID },
  { sheetId: 900, title: 'Ref', gridProperties: { rowCount: 1000, columnCount: 26 } },
];

function sheetsStub(o: { getError?: unknown; batchError?: unknown } = {}) {
  const calls: { get: unknown[]; batchGet: { ranges: string[]; valueRenderOption: string }[] } = { get: [], batchGet: [] };
  const client = {
    spreadsheets: {
      get: async (args: unknown) => {
        calls.get.push(args);
        if (o.getError) throw o.getError;
        return { data: { sheets: TABS.map((properties) => ({ properties })) } };
      },
      values: {
        batchGet: async (args: { ranges: string[]; valueRenderOption: string }) => {
          calls.batchGet.push(args);
          if (o.batchError) throw o.batchError;
          return {
            data: {
              valueRanges: [
                { values: [['Left gym_id', 'Right gym_id'], ['G022', 'G025']] },
                { values: [['ROSTER']] },
                {}, // a range with nothing in it comes back without values
              ],
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Parameters<typeof readMatchTab>[1], calls };
}

test('the reader maps the gid to its tab and reads the anchors, quoted, as formatted values', async () => {
  const { client, calls } = sheetsStub();
  const tab = await readMatchTab({ spreadsheetId: 'abc', gid: '777' }, client);
  assert.equal(tab.title, '1');
  assert.deepEqual(calls.batchGet[0].ranges, ["'1'!AK1:AP13", "'1'!C17:S19", "'1'!C21:R41"]);
  assert.equal(calls.batchGet[0].valueRenderOption, 'FORMATTED_VALUE');
  assert.deepEqual(tab.cells, { AK1: 'Left gym_id', AL1: 'Right gym_id', AK2: 'G022', AL2: 'G025', C17: 'ROSTER' });
});

test('a gid that names no tab is TabNotFound', async () => {
  const { client } = sheetsStub();
  await assert.rejects(readMatchTab({ spreadsheetId: 'abc', gid: '12345' }, client), (e) => e instanceof TabNotFound && e.gid === '12345');
});

test('a tab smaller than the layout, such as Ref, is not read and comes back empty', async () => {
  const { client, calls } = sheetsStub();
  const tab = await readMatchTab({ spreadsheetId: 'abc', gid: '900' }, client);
  assert.deepEqual(tab, { title: 'Ref', cells: {} });
  assert.equal(calls.batchGet.length, 0);
});

test('a workbook the bot can\'t open is SheetAccessError; other failures pass through', async () => {
  for (const err of [{ code: 403 }, { response: { status: 404 } }, { status: 403 }]) {
    const { client } = sheetsStub({ getError: Object.assign(new Error('denied'), err) });
    await assert.rejects(readMatchTab({ spreadsheetId: 'abc', gid: '777' }, client), SheetAccessError);
  }
  const quota = Object.assign(new Error('quota'), { code: 429 });
  await assert.rejects(readMatchTab({ spreadsheetId: 'abc', gid: '777' }, sheetsStub({ batchError: quota }).client), (e) => e === quota);
});

// ---- The results announcement ----------------------------------------------------

const gym = (gymId: string, name: string, emote: string, score: number): GymScore => ({ gymId, name, emote, score });

function discordStub() {
  const posted: { channelId: string; embed: Embed }[] = [];
  const rendered: string[] = [];
  return {
    posted,
    rendered,
    client: {
      renderEmote: async (_guild: string, emote: string) => {
        rendered.push(emote);
        return emote === ':summit:' ? '<:summit:111>' : emote;
      },
      postEmbed: async (channelId: string, embed: Embed) => { posted.push({ channelId, embed }); },
    },
  };
}

test('the announcement posts one embed to the results channel, winner first, with rendered emotes', async () => {
  process.env.DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID = '555';
  const d = discordStub();
  const now = new Date('2026-11-20T18:00:00Z');
  await announceResult('g', gym('G022', 'Phoenix', '🔥', 9), gym('G025', 'Summit', ':summit:', 10), now, d.client);
  assert.deepEqual(d.posted, [{
    channelId: '555',
    embed: { description: '<:summit:111> **Summit** defeated 🔥 **Phoenix** with a score of **10-9**', timestamp: '2026-11-20T18:00:00.000Z' },
  }]);
});

test('a blank emote is left out and never looked up', async () => {
  process.env.DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID = '555';
  const d = discordStub();
  await announceResult('g', gym('G010', 'The Dark League', '  ', 10), gym('G025', 'Summit', ':summit:', 4), new Date(), d.client);
  assert.deepEqual(d.rendered, [':summit:']);
  assert.match(d.posted[0].embed.description, /^\*\*The Dark League\*\* defeated <:summit:111> \*\*Summit\*\*/);
});

test('with no results channel set, the announcement fails before calling Discord', async () => {
  delete process.env.DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID;
  const d = discordStub();
  await assert.rejects(announceResult('g', gym('A', 'A', ':a:', 10), gym('B', 'B', '', 2), new Date(), d.client), /not set/);
  assert.deepEqual([d.rendered, d.posted], [[], []]);
});

// ---- Button routing ----------------------------------------------------------------

test('Save and Cancel route to the match handlers; Save shows the saving line at once', () => {
  const hash = 'abcdef012345';
  assert.deepEqual(componentRoute(saveButtonId('1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg', '777', hash)), {
    handler: handleMatchSave, pending: MATCH_SAVING,
  });
  assert.deepEqual(componentRoute(cancelButtonId(hash)), { handler: handleMatchCancel });
});

test('the existing buttons keep their routes, and anything else has none', () => {
  assert.deepEqual(componentRoute('approve:R0001'), { handler: handleDecision, pending: CARD_PROCESSING });
  assert.deepEqual(componentRoute('reject:R0001'), { handler: handleDecision, pending: CARD_PROCESSING });
  assert.deepEqual(componentRoute('disband:confirm:G001'), { handler: handleDisbandButton });
  for (const id of ['msave', 'mcancelx:1', 'approver:R1', 'unknown:1', '']) assert.equal(componentRoute(id), undefined, id);
});
