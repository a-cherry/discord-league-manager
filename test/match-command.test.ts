import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchHandlers, matchCommand, type MatchDeps } from '../src/commands/match.js';
import type { ActionRow } from '../src/discord.js';
import type { CommandInteraction, CommandResult, ComponentInteraction, ComponentResult } from '../src/interactions.js';
import type { GymScore } from '../src/match/format.js';
import type { MatchCells } from '../src/match/parse.js';
import { SheetAccessError, TabNotFound, fitsMatchLayout, parseSheetLink } from '../src/match/sheet-reader.js';
import { exampleMatch, league } from './fixtures.js';
import { FakeMatchStore } from './match-store-fake.js';

const OPS = '900000000000000001';
const STAFF = '1300000000000000001';
const SHEET_ID = '1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg';
const LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=777`;
const DECKS = [
  'Mega Lucario ex Lucario', 'Hoopa Ex Mega Sableye EX', 'Mega Altaria ex Espeon', 'Vespiquen ex Shuckle ex',
  'Mega Blaziken ex Greninja', 'Hoopa Ex Mega Absol EX', 'Suicune ex Baxcalibur',
];

interface Posted { text: string; components?: ActionRow[] }

function setup(o: {
  cells?: (c: MatchCells) => void; decks?: boolean; staff?: boolean; failPost?: boolean; failAnnounce?: boolean; crashAt?: string;
} = {}) {
  const store = new FakeMatchStore(league());
  if (o.decks !== false) store.tabs.decks.push(...DECKS.map((name) => ({ name, active: true })));
  const fixture = exampleMatch();
  let cells = fixture.cells;
  o.cells?.(cells);
  const posted: Posted[] = [];
  const announced: [GymScore, GymScore][] = [];
  const logged: string[] = [];
  let readError: Error | undefined;
  const deps: MatchDeps = {
    isStaff: () => o.staff !== false,
    opsChannelId: () => OPS,
    readTab: async (link) => {
      if (readError) throw readError;
      assert.deepEqual(link, { spreadsheetId: SHEET_ID, gid: '777' });
      return { title: '1', hidden: false, cells: structuredClone(cells) };
    },
    store,
    postOps: async (text, components) => {
      if (o.failPost) throw new Error('Missing Access');
      posted.push({ text, components });
    },
    announce: async (_g, l, r) => {
      if (o.failAnnounce) throw new Error('Missing Access');
      announced.push([l, r]);
    },
    rebuildViews: async () => {},
    serviceAccountEmail: () => 'ggb-bot@example.iam.gserviceaccount.com',
    sequenceRules: () => 'fail',
    log: (m) => logged.push(m),
    crash: (p) => { if (p === o.crashAt) throw new Error(`stopped at ${p}`); },
  };
  return {
    ...matchHandlers(deps), store, posted, announced, logged,
    editCells: (f: (c: MatchCells) => void) => { cells = structuredClone(cells); f(cells); },
    failRead: (err: Error) => (readError = err),
  };
}

const command = (sheet = LINK, channel = OPS): CommandInteraction => ({
  application_id: 'app', token: 't', guild_id: 'g', channel_id: channel,
  member: { user: { id: STAFF, username: 'staff', global_name: null }, nick: null, roles: [] },
  data: { name: 'match', options: [{ name: 'submit', type: 1, options: [{ name: 'sheet', type: 3, value: sheet }] }] },
});

const press = (customId: string, content: string, userId = '1300000000000000002'): ComponentInteraction => ({
  application_id: 'app', token: 't', guild_id: 'g',
  member: { user: { id: userId, username: 'staff2', global_name: null }, nick: null, roles: [] },
  data: { custom_id: customId },
  message: { id: 'm', content },
});

const reply = (r: string | CommandResult) => (typeof r === 'string' ? r : r.reply);
const buttonIds = (p: Posted) => p.components![0].components.map((b) => b.custom_id);

// ---- Links and access -------------------------------------------------------------

test('links: the workbook ID and the gid, from #gid=, ?gid= or &gid=', () => {
  assert.deepEqual(parseSheetLink(LINK), { spreadsheetId: SHEET_ID, gid: '777' });
  assert.deepEqual(parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=5#gid=5`).gid, '5');
  assert.deepEqual(parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`), { spreadsheetId: SHEET_ID, gid: undefined });
  assert.equal(parseSheetLink('https://example.com/?gid=1').spreadsheetId, undefined);
});

test('a tab smaller than the match layout is not read; Ref has only 26 columns', () => {
  assert.equal(fitsMatchLayout({ rowCount: 1000, columnCount: 26 }), false);
  assert.equal(fitsMatchLayout({ rowCount: 40, columnCount: 50 }), false);
  assert.equal(fitsMatchLayout({ rowCount: 41, columnCount: 42 }), true);
  assert.equal(fitsMatchLayout(undefined), false);
});

test('/match submit is staff only, in #bot-ops', async () => {
  assert.equal(reply(await setup({ staff: false }).handleMatch(command())), 'Only staff can submit match sheets.');
  assert.equal(reply(await setup().handleMatch(command(LINK, '123'))), `Run /match submit in <#${OPS}>.`);
});

test('a link without #gid= asks for the tab\'s own link', async () => {
  const h = setup();
  assert.match(reply(await h.handleMatch(command(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`))), /has no #gid=/);
  assert.equal(reply(await h.handleMatch(command('not a link'))), "That isn't a link to a Google Sheet.");
  assert.equal(h.posted.length, 0);
});

test('a workbook the bot can\'t open names the service account to share it with', async () => {
  const h = setup();
  h.failRead(new SheetAccessError(403));
  assert.match(reply(await h.handleMatch(command())), /Share it with ggb-bot@example\.iam\.gserviceaccount\.com/);
  h.failRead(new TabNotFound('777'));
  assert.match(reply(await h.handleMatch(command())), /no tab with gid 777/);
  assert.equal(h.posted.length, 0);
});

test('a tab that fails the sentinels gets a layout reply, not a validation list', async () => {
  const h = setup({ cells: (c) => { c.AK1 = 'Something else'; } });
  const r = reply(await h.handleMatch(command()));
  assert.match(r, /^Tab 1 isn't a match tab, or its layout has moved/);
  assert.match(r, /AK1 reads "Something else", expected "Left gym\\_id"/);
  assert.equal(h.posted.length, 0);
  assert.deepEqual(h.store.calls, [], 'the League DB is not read');
});

// ---- The three outcomes ---------------------------------------------------------------

test('a clean sheet saves at once, with no buttons, posts the record and points the submitter at it', async () => {
  const h = setup();
  const r = await h.handleMatch(command());
  assert.equal(reply(r), `Saved as M0001. The record is in <#${OPS}>.`);
  assert.equal(typeof r, 'string', 'no buttons');
  assert.equal(h.announced.length, 1);
  assert.deepEqual(h.posted.map((p) => p.text), [[
    'Match Sheet Submitted M0001',
    'Week 1: Summit 10-9 Phoenix',
    `Submitted by <@${STAFF}>`,
    'Announcement: posted',
    'W1: 1 match saved',
  ].join('\n')]);
  assert.equal(h.store.tabs.matches[0].status, 'complete');
});

test('if the record post fails, the match stays saved and the reply carries the record', async () => {
  for (const o of [{ crashAt: 'match.log' }, { failPost: true }]) {
    const h = setup(o);
    const r = reply(await h.handleMatch(command()));
    assert.match(r, /^Match Sheet Submitted M0001\n/);
    assert.equal(h.store.tabs.matches[0].status, 'complete');
    assert.deepEqual(h.logged, ['M0001: the #bot-ops record post failed']);
  }
});

test('failures are posted publicly in #bot-ops and the submitter gets a pointer', async () => {
  const h = setup({ cells: (c) => { delete c.AO2; c.K21 = 'W'; c.M21 = 'W'; } });
  const r = reply(await h.handleMatch(command()));
  assert.equal(r, `Tab 1 has 2 problems, listed in <#${OPS}>. Nothing was saved.`);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].text, 'Tab 1: 2 problems\nWeek is blank\nRow 21: both sides W');
  assert.equal(h.posted[0].components, undefined);
  assert.deepEqual(h.store.calls, ['snapshot'], 'nothing is written');
});

test('if the #bot-ops post fails, the submitter\'s reply carries the failure list', async () => {
  const h = setup({ failPost: true, cells: (c) => { delete c.AO2; } });
  assert.equal(reply(await h.handleMatch(command())), 'Tab 1: 1 problem\nWeek is blank');
  assert.deepEqual(h.logged, ['the failure list failed to post in #bot-ops']);
});

test('warnings are posted with Save and Cancel; nothing is written until Save', async () => {
  const h = setup({ decks: false });
  const r = reply(await h.handleMatch(command()));
  assert.equal(r, `Tab 1 has 7 warnings. Save or Cancel on the post in <#${OPS}>.`);
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0].text, /^Tab 1: 7 warnings\nNew deck: Mega Lucario ex Lucario\n/);
  const [save, cancel] = buttonIds(h.posted[0]);
  assert.match(save, new RegExp(`^msave:${SHEET_ID}:777:[0-9a-f]{12}$`));
  assert.equal(cancel, `mcancel:${save.slice(-12)}`);
  assert.equal(h.store.tabs.matches.length, 0);
});

test('if the warnings post fails, the submitter gets the warnings and the buttons', async () => {
  const h = setup({ decks: false, failPost: true });
  const r = await h.handleMatch(command());
  assert.equal(typeof r, 'object');
  const { reply: text, components } = r as CommandResult;
  assert.match(text, /^Tab 1: 7 warnings/);
  assert.equal(components![0].components.length, 2);
});

// ---- Save and Cancel ----------------------------------------------------------------------

async function warned() {
  const h = setup({ decks: false });
  await h.handleMatch(command());
  const post = h.posted[0];
  const [saveId, cancelId] = buttonIds(post);
  return { h, post, saveId, cancelId };
}

test('Save on an unchanged sheet saves as whoever pressed it, with the record under the warnings', async () => {
  const { h, post, saveId } = await warned();
  const result = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.equal(result.message, [
    post.text,
    'Saved by <@1300000000000000002>',
    '---',
    'Match Sheet Submitted M0001',
    'Week 1: Summit 10-9 Phoenix',
    'Announcement: posted',
    'W1: 1 match saved',
  ].join('\n'));
  assert.equal(result.reply, undefined, 'no private reply');
  assert.equal(h.posted.length, 1, 'no separate record post');
  assert.equal(h.store.tabs.decks.length, 7, 'Save appends the new decks');
  assert.equal(h.store.tabs.matches[0].submitted_by, '1300000000000000002');
  assert.ok(result.message!.length < 2000);
});

test('the longest warnings post still fits with the record under it', async () => {
  const many = Array.from({ length: 100 }, (_, i) => `New deck: ${'x'.repeat(30)} ${i}`);
  const { issueList } = await import('../src/match/format.js');
  const { WARNINGS_BUDGET } = await import('../src/commands/match.js');
  const longest = issueList('16', 'warning', many, WARNINGS_BUDGET);
  const record = 'Saved by <@1300000000000000002>\n---\nMatch Sheet Resubmitted M0014\nPlayoff Week 12: ' +
    `${'x'.repeat(90)} 10-9 ${'y'.repeat(90)}\nScore changed: ${'x'.repeat(90)} 9 to 10, ${'y'.repeat(90)} 10 to 9\n` +
    'Announcement: not needed, score unchanged\nPlayoff W12: 16 matches saved';
  assert.ok(`${longest}\n${record}`.length <= 2000, `${longest.length + record.length + 1}`);
});

test('if the record fails under the warnings, the post still says who saved it', async () => {
  const h = setup({ decks: false, crashAt: 'match.log' });
  await h.handleMatch(command());
  const post = h.posted[0];
  const result = await h.handleSave(press(buttonIds(post)[0], post.text)) as ComponentResult;
  assert.equal(result.message, `${post.text}\nSaved by <@1300000000000000002>`);
  assert.equal(h.store.tabs.matches[0].status, 'complete');
});

test('Save on a sheet that changed after the warnings saves nothing', async () => {
  const { h, post, saveId } = await warned();
  h.editCells((c) => { c.G21 = 'Mega Lucario Exx'; });
  const result = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.equal(result.message, `${post.text}\nThe sheet changed after these warnings, so nothing was saved. Submit the tab again.`);
  assert.equal(h.store.tabs.matches.length, 0);
});

test('Save on a sheet that now fails shows the failure list instead', async () => {
  const { h, post, saveId } = await warned();
  h.editCells((c) => { delete c.AO2; });
  const result = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.equal(result.message, 'Tab 1: 1 problem\nWeek is blank\nThe sheet now fails, so nothing was saved.');
  assert.equal(h.store.tabs.matches.length, 0);
});

test('formatting-only edits after the warnings still save', async () => {
  const { h, post, saveId } = await warned();
  h.editCells((c) => { c.G21 = '  Mega Lucario ex   Lucario '; c.F11 = 'PHOENIX'; c.L21 = 'x'; });
  const result = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.match(result.message!, /Saved by/);
});

test('a deck another save added since the warnings does not read as a changed sheet', async () => {
  const { h, post, saveId } = await warned();
  h.store.tabs.decks.push({ name: 'MEGA LUCARIO EX LUCARIO', active: true });
  const result = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.match(result.message!, /Saved by/);
  assert.equal(h.store.tabs.games[0].deck_left, 'MEGA LUCARIO EX LUCARIO');
  assert.equal(h.store.tabs.decks.length, 7);
});

test('a second Save press replaces the match with the same data and does not re-announce', async () => {
  const { h, post, saveId } = await warned();
  await h.handleSave(press(saveId, post.text));
  const second = await h.handleSave(press(saveId, post.text)) as ComponentResult;
  assert.match(second.message!, /\nMatch Sheet Resubmitted M0001\n/);
  assert.match(second.message!, /Announcement: not needed, score unchanged/);
  assert.equal(h.announced.length, 1);
  assert.equal(h.store.tabs.games.length, 19);
});

test('Save and Cancel are staff only; the buttons stay', async () => {
  const h = setup({ staff: false });
  assert.deepEqual(await h.handleSave(press(`msave:${SHEET_ID}:777:abcdef012345`, 'x')), { reply: 'Only staff can save match sheets.' });
  assert.deepEqual(await h.handleCancel(press('mcancel:abcdef012345', 'x')), { reply: 'Only staff can cancel match sheets.' });
});

test('Cancel says who cancelled, removes the buttons and writes nothing', async () => {
  const { h, post, cancelId } = await warned();
  const result = await h.handleCancel(press(cancelId, post.text)) as ComponentResult;
  assert.equal(result.message, `${post.text}\nCancelled by <@1300000000000000002>. Nothing was saved.`);
  assert.equal(result.components, undefined, 'no buttons');
  assert.equal(h.store.tabs.matches.length, 0);
});

// ---- Save failures --------------------------------------------------------------------------

test('a save that stops partway tells the submitter and posts in #bot-ops', async () => {
  const h = setup();
  h.store.appendGames = async () => { throw new Error('Sheets 500'); };
  const r = reply(await h.handleMatch(command()));
  assert.equal(r, 'The save stopped partway, so M0001 is pending. Submit the tab again to finish it.');
  assert.equal(h.posted[0].text, '**M0001 is pending.** The save of Week 1: Phoenix vs Summit stopped partway. Submit tab 1 again to finish it.');
  assert.equal(h.store.tabs.matches[0].status, 'pending');
});

test('a failed announcement still saves, and the record says to post it by hand', async () => {
  const h = setup({ failAnnounce: true });
  const r = reply(await h.handleMatch(command()));
  assert.equal(r, `Saved as M0001. The record is in <#${OPS}>.`);
  assert.match(h.posted.at(-1)!.text, /Announcement: failed, post by hand/);
  assert.equal(h.store.tabs.matches[0].status, 'complete');
});

test('the week cap inside the save is reported, and nothing is saved', async () => {
  // Validation sees an empty week; by the time the save reads, another match has filled it.
  const h = setup();
  const read = h.store.readForSave.bind(h.store);
  h.store.readForSave = async () => {
    const state = await read();
    state.matches.push({ rowNumber: 99, values: {
      match_id: 'M0050', season: '5', stage: 'Regular', week: '1', gym_left_id: 'X', gym_right_id: 'Y',
      score_left: '10', score_right: '8', status: 'complete', tab_link: '', submitted_by: '', submitted_at: '',
    } });
    return state;
  };
  const r = reply(await h.handleMatch(command()));
  assert.equal(r, 'S5 Regular W1 already has 1 matches, so nothing was saved. Check the season, stage and week cells.');
  assert.equal(h.store.tabs.matches.length, 0);
});

// ---- The command definition --------------------------------------------------------------------

test('the command is /match submit with one required sheet option', () => {
  assert.equal(matchCommand.name, 'match');
  assert.deepEqual(matchCommand.options.map((o) => o.name), ['submit']);
  assert.deepEqual(matchCommand.options[0].options.map((o) => [o.name, o.required]), [['sheet', true]]);
});
