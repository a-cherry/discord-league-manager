import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type GymScore, type PriorMatch, type SavedMatch, CUSTOM_ID_LIMIT, MESSAGE_BUDGET,
  announcementText, cancelButtonId, echo, failurePost, matchHeading, parseSaveButtonId, recordPost, saveButtonId,
  warningsPost,
  shouldAnnounce, weekCountLine,
} from '../src/match/format.js';

const phoenix = (score: number): GymScore => ({ gymId: 'G022', name: 'Phoenix', emote: ':phoenix~1:', score });
const summit = (score: number): GymScore => ({ gymId: 'G025', name: 'Summit', emote: ':summit:', score });
const prior = (v: Partial<PriorMatch> = {}): PriorMatch => ({
  status: 'complete', gymLeftId: 'G022', gymRightId: 'G025', scoreLeft: '9', scoreRight: '10', ...v,
});

// ---- Match check posts ----------------------------------------------------------

const HEADING = '**Match check: Week 1, Pocket Refs vs Old Gym**';

test('the heading names the week and both gyms, or the tab when they can\'t be read', () => {
  assert.equal(matchHeading('1', { stage: 'Regular', week: 1 }, { left: 'Pocket Refs', right: 'Old Gym' }), HEADING);
  assert.equal(matchHeading('1', { stage: 'Playoff', week: 2 }, { left: 'A', right: 'B' }), '**Match check: Playoff Week 2, A vs B**');
  assert.equal(matchHeading('1', { stage: 'Regular', week: 1 }), '**Match check: Week 1, Tab 1**');
  assert.equal(matchHeading('1', undefined, { left: 'A', right: 'B' }), '**Match check: A vs B**');
  assert.equal(matchHeading('1'), '**Match check: Tab 1**');
  assert.equal(matchHeading('1', undefined, { left: 'Team_Rocket', right: 'B' }), '**Match check: Team\\_Rocket vs B**');
});

test('the warnings post says what to confirm and what to press', () => {
  assert.equal(warningsPost(HEADING, '1', ['Row 35: Katsuo Nakahara subbed in for dinkle\\_alt1']), [
    HEADING,
    "Tab 1 has 1 thing to confirm before it's saved:",
    '',
    '- Row 35: Katsuo Nakahara subbed in for dinkle\\_alt1',
    '',
    'If this is right, press Save. If not, press Cancel, fix the sheet and submit it again.',
  ].join('\n'));
  const two = warningsPost(HEADING, '1', ['New deck: X', 'New deck: Y']);
  assert.match(two, /has 2 things to confirm/);
  assert.match(two, /If these are right, press Save/);
});

test('the failure post says it wasn\'t saved and what to fix', () => {
  assert.equal(failurePost(HEADING, '1', ['Row 21: both sides W', 'Row 27: left result blank']), [
    HEADING,
    "Tab 1 wasn't saved. Fix these on the sheet, then submit it again:",
    '',
    '- Row 21: both sides W',
    '- Row 27: left result blank',
  ].join('\n'));
  assert.match(failurePost(HEADING, '1', ['Week is blank']), /Fix this on the sheet/);
  assert.match(failurePost(HEADING, '1', ['Week is blank'], undefined, true),
    /^\*\*Match check.*\*\*\nTab 1 changed after the warnings and now has problems, so it wasn't saved\./);
});

test('with 100 failures and a long heading the post stays under 2000 characters and ends with "and N more"', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `Row ${21 + (i % 19)}: Left Player ${i} isn't in Phoenix's roster slots, and no active Phoenix Trainer has that server nickname`);
  const heading = matchHeading('16', { stage: 'Playoff', week: 12 }, { left: 'x'.repeat(90), right: 'y'.repeat(90) });
  const msg = failurePost(heading, '16', lines);
  assert.ok(msg.length <= MESSAGE_BUDGET, `${msg.length}`);
  const out = msg.split('\n');
  assert.equal(out[0], heading);
  const shown = out.filter((l) => l.startsWith('- '));
  assert.equal(out.at(-1), `and ${100 - shown.length} more`);
  assert.deepEqual(shown, lines.slice(0, shown.length).map((l) => `- ${l}`));
  const warn = warningsPost(heading, '16', lines, 1400);
  assert.ok(warn.length <= 1400, `${warn.length}`);
  assert.match(warn, /and \d+ more\n\nIf these are right/);
});

test('echoed text is one line, without links, capped, and cannot ping', () => {
  assert.equal(echo('a\nb   c'), 'a b c');
  assert.equal(echo('see https://evil.example/x now'), 'see \\[link\\] now');
  assert.ok(!echo('@everyone').includes('@everyone'));
  assert.ok(!echo('@here').includes('@here'));
  for (const m of ['<@&123456789012345678>', '<@123456789012345678>', '<@!123456789012345678>']) {
    assert.doesNotMatch(echo(m), /<@[!&]?\d+>/, m);
  }
  const long = echo('x'.repeat(100));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
  assert.equal(echo('Team_Rocket*'), 'Team\\_Rocket\\*');
});

// ---- Week count line ---------------------------------------------------------

test('the week count line for Regular and for Playoff', () => {
  assert.equal(weekCountLine('Regular', 1, 14), 'W1: 14 matches saved');
  assert.equal(weekCountLine('Playoff', 1, 3), 'Playoff W1: 3 matches saved');
  assert.equal(weekCountLine('Regular', 2, 1), 'W2: 1 match saved');
});

// ---- Announcement -------------------------------------------------------------

test('the announce rule: new, prior pending, score changed, unchanged, sides swapped', () => {
  assert.equal(shouldAnnounce(undefined, phoenix(9), summit(10)), true, 'new match');
  assert.equal(shouldAnnounce(prior({ status: 'pending' }), phoenix(9), summit(10)), true, 'prior pending row');
  assert.equal(shouldAnnounce(prior(), phoenix(8), summit(10)), true, 'score changed');
  assert.equal(shouldAnnounce(prior(), phoenix(9), summit(10)), false, 'score unchanged');
  const swapped = prior({ gymLeftId: 'G025', gymRightId: 'G022', scoreLeft: '10', scoreRight: '9' });
  assert.equal(shouldAnnounce(swapped, phoenix(9), summit(10)), false, 'sides swapped');
});

test('the announcement puts the winner first and drops a blank emote', () => {
  assert.equal(announcementText(phoenix(9), summit(10)), ':summit: **Summit** defeated :phoenix~1: **Phoenix** with a score of **10-9**');
  assert.equal(
    announcementText({ ...phoenix(10), emote: '', name: 'The_Dark League' }, summit(8)),
    '**The\\_Dark League** defeated :summit: **Summit** with a score of **10-8**',
  );
});

// ---- Reply and record post ---------------------------------------------------------

const saved = (v: Partial<SavedMatch> = {}): SavedMatch => ({
  matchId: 'M0014', replaced: false, stage: 'Regular', week: 1, left: phoenix(9), right: summit(10), weekCount: 14, ...v,
});

test('the record post: the match ID in the title, the score winner first', () => {
  assert.equal(
    recordPost({ ...saved(), submittedBy: '1300000000000000001', announcement: 'posted' }),
    [
      'Match Sheet Submitted M0014',
      'Week 1: Summit 10-9 Phoenix',
      'Submitted by <@1300000000000000001>',
      'Announcement: posted',
      'W1: 14 matches saved',
    ].join('\n'),
  );
});

test('under a warnings post the record leaves out who submitted it', () => {
  assert.equal(
    recordPost({ ...saved(), announcement: 'posted' }),
    'Match Sheet Submitted M0014\nWeek 1: Summit 10-9 Phoenix\nAnnouncement: posted\nW1: 14 matches saved',
  );
});

test('the record post for a replace shows the score change only when there is one', () => {
  const changed = recordPost({ ...saved({ replaced: true }), prior: prior({ scoreLeft: '8' }), announcement: 'posted' }).split('\n');
  assert.equal(changed[0], 'Match Sheet Resubmitted M0014');
  assert.equal(changed[2], 'Score changed: Phoenix 8 to 9, Summit 10 to 10');
  const same = recordPost({ ...saved({ replaced: true }), prior: prior(), announcement: 'unchanged' });
  assert.ok(!same.includes('Score changed'));
  assert.ok(same.includes('Announcement: not needed, score unchanged'));
});

test('the record post shows each announcement outcome', () => {
  const post = (announcement: 'posted' | 'unchanged' | 'failed') => recordPost({ ...saved(), announcement });
  assert.ok(post('posted').includes('Announcement: posted'));
  assert.ok(post('unchanged').includes('Announcement: not needed, score unchanged'));
  assert.ok(post('failed').split('\n').includes('**Announcement: failed, post by hand**'));
  assert.ok(!post('posted').includes('**'), 'only a failure is bold');
  assert.ok(!post('posted').includes('Approved by'));
});

test('a Playoff record post names the stage', () => {
  const lines = recordPost({ ...saved({ stage: 'Playoff', weekCount: 3 }), announcement: 'posted' }).split('\n');
  assert.equal(lines[1], 'Playoff Week 1: Summit 10-9 Phoenix');
  assert.equal(lines.at(-1), 'Playoff W1: 3 matches saved');
});

// ---- Buttons ------------------------------------------------------------------------

test('custom_ids stay under 100 with a maximum-length spreadsheet ID and gid', () => {
  const spreadsheetId = '1xaTNBCumylo92Q6-_DVXR-CQFw59i5BOu0Xf4aDS6fg'; // 44 characters
  const gid = '2147483647';
  const hash = 'abcdef012345';
  const save = saveButtonId(spreadsheetId, gid, hash);
  assert.ok(save.length < CUSTOM_ID_LIMIT, `${save.length}`);
  assert.ok(cancelButtonId(hash).length < CUSTOM_ID_LIMIT);
  assert.deepEqual(parseSaveButtonId(save), { spreadsheetId, gid, hash });
  assert.equal(parseSaveButtonId('msave:x:1:nothex'), undefined);
  assert.throws(() => saveButtonId('x'.repeat(90), gid, hash));
});
