// Messages for /match submit: failure and warning lists, the week count line,
// the results announcement and its rule, the #bot-ops record post, and the
// Save/Cancel custom_ids. Pure: no Sheets or Discord
// imports (escapeMarkdown mirrors the one in src/discord.ts for that reason).

export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|<>[\]()]/g, '\\$&');

// Lists stop before this, so the whole message stays under Discord's 2000.
export const MESSAGE_BUDGET = 1900;
const ECHO_MAX = 40;

// Cell text quoted back in a message: one line, links removed, capped, with
// markdown escaped and @ broken so it can't ping. (allowed_mentions limits
// pings to users anyway; this also stops a typed <@id> pinging that user.)
export function echo(text: string, max = ECHO_MAX): string {
  let s = text.replace(/\s+/g, ' ').trim().replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]');
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return escapeMarkdown(s).replace(/@/g, '@​');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Bullets until the budget, then "and N more", so a post stays under Discord's limit.
function bullets(lines: string[], budget: number): string {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = `- ${lines[i]}`;
    const rest = lines.length - i - 1;
    const tail = rest > 0 ? `\nand ${rest} more`.length : 0;
    if (length + line.length + 1 + tail > budget) {
      out.push(`and ${lines.length - i} more`);
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join('\n');
}

// The heading of a match check post: the week and both gyms when the sheet
// gives them, else the tab in their place.
//   **Match check: Week 1, Pocket Refs vs Old Gym**
//   **Match check: Week 1, Tab 1**   (a gym can't be read)
export function matchHeading(
  tab: string, week?: { stage: string; week: number }, gyms?: { left: string; right: string },
): string {
  const parts = [
    ...(week ? [weekLabel(week.stage, week.week, true)] : []),
    gyms ? `${escapeMarkdown(gyms.left)} vs ${escapeMarkdown(gyms.right)}` : `Tab ${echo(tab)}`,
  ];
  return `**Match check: ${parts.join(', ')}**`;
}

// The public post for a sheet with warnings, above Save and Cancel. A post
// that gets lines added later (Saved by, the record) passes a smaller budget.
export function warningsPost(heading: string, tab: string, lines: string[], budget = MESSAGE_BUDGET): string {
  const one = lines.length === 1;
  const head = `${heading}\nTab ${echo(tab)} has ${plural(lines.length, 'thing')} to confirm before it's saved:\n\n`;
  const foot = `\n\nIf ${one ? 'this is' : 'these are'} right, press Save. If not, press Cancel, fix the sheet and submit it again.`;
  return head + bullets(lines, budget - head.length - foot.length) + foot;
}

// The public post for a sheet that fails. `changed`: it failed when Save
// checked it again, after passing with warnings.
export function failurePost(heading: string, tab: string, lines: string[], budget = MESSAGE_BUDGET, changed = false): string {
  const what = changed
    ? `Tab ${echo(tab)} changed after the warnings and now has problems, so it wasn't saved.`
    : `Tab ${echo(tab)} wasn't saved.`;
  const head = `${heading}\n${what} Fix ${lines.length === 1 ? 'this' : 'these'} on the sheet, then submit it again:\n\n`;
  return head + bullets(lines, budget - head.length);
}

// ---- Week labels ------------------------------------------------------------

// "W1" / "Playoff W1", or with long: "Week 1" / "Playoff Week 1".
export function weekLabel(stage: string, week: number, long = false): string {
  const w = long ? `Week ${week}` : `W${week}`;
  return stage === 'Regular' ? w : `${stage} ${w}`;
}

export const weekCountLine = (stage: string, week: number, count: number) =>
  `${weekLabel(stage, week)}: ${plural(count, 'match', 'matches')} saved`;

// ---- Results ----------------------------------------------------------------

export interface GymScore {
  gymId: string;
  name: string;
  emote: string;
  score: number;
}

const winnerFirst = (a: GymScore, b: GymScore) => (a.score >= b.score ? [a, b] : [b, a]);

const gymText = (g: GymScore) => `${g.emote ? `${g.emote} ` : ''}**${escapeMarkdown(g.name)}**`;

// The announcement embed's text, winner first:
// ":summit: **Summit** defeated :phoenix: **Phoenix** with a score of **10-9**"
export function announcementText(left: GymScore, right: GymScore): string {
  const [w, l] = winnerFirst(left, right);
  return `${gymText(w)} defeated ${gymText(l)} with a score of **${w.score}-${l.score}**`;
}

export interface PriorMatch {
  status: string;
  gymLeftId: string;
  gymRightId: string;
  scoreLeft: string;
  scoreRight: string;
}

// Each gym's score on the earlier Matches row, by gym_id.
const priorScores = (p: PriorMatch) =>
  new Map([[p.gymLeftId, Number(p.scoreLeft)], [p.gymRightId, Number(p.scoreRight)]]);

// The gyms whose score differs from the earlier complete row, as
// [gym, before, after]; undefined when there is no earlier complete row.
export function scoreChanges(prior: PriorMatch | undefined, left: GymScore, right: GymScore) {
  if (!prior || prior.status !== 'complete') return undefined;
  const before = priorScores(prior);
  return [left, right].map((g) => ({ gym: g, before: before.get(g.gymId), after: g.score }));
}

// Announce when there is no earlier complete row for this match, or either
// gym's score differs from it. Compared per gym, so swapped sides aren't a change.
export function shouldAnnounce(prior: PriorMatch | undefined, left: GymScore, right: GymScore): boolean {
  const changes = scoreChanges(prior, left, right);
  return !changes || changes.some((c) => c.before !== c.after);
}

// ---- Replies and the record post --------------------------------------------

export interface SavedMatch {
  matchId: string;
  replaced: boolean;
  stage: string;
  week: number;
  left: GymScore;
  right: GymScore;
  weekCount: number;
}

export type AnnouncementOutcome = 'posted' | 'unchanged' | 'failed';
const ANNOUNCEMENT_LINE: Record<AnnouncementOutcome, string> = {
  posted: 'posted',
  unchanged: 'not needed, score unchanged',
  failed: 'failed, post by hand',
};

// The #bot-ops audit record after every successful save:
//   Match Sheet Submitted M0001
//   Week 1: Pocket Refs 10-5 Old Gym
//   Submitted by @staff          (only with submittedBy; see below)
//   Announcement: posted
//   W1: 1 match saved
// A save from a warnings post goes under that post's "Saved by @staff" line,
// so it leaves out submittedBy.
export function recordPost(
  m: SavedMatch & { prior?: PriorMatch; submittedBy?: string; announcement: AnnouncementOutcome },
): string {
  const [w, l] = winnerFirst(m.left, m.right);
  const lines = [
    `${m.replaced ? 'Match Sheet Resubmitted' : 'Match Sheet Submitted'} ${m.matchId}`,
    `${weekLabel(m.stage, m.week, true)}: ${escapeMarkdown(w.name)} ${w.score}-${l.score} ${escapeMarkdown(l.name)}`,
  ];
  const changes = m.replaced ? scoreChanges(m.prior, m.left, m.right) : undefined;
  if (changes?.some((c) => c.before !== c.after)) {
    lines.push(`Score changed: ${changes.map((c) => `${escapeMarkdown(c.gym.name)} ${c.before ?? '?'} to ${c.after}`).join(', ')}`);
  }
  if (m.submittedBy) lines.push(`Submitted by <@${m.submittedBy}>`);
  // A failed announcement is bold, so staff see they have to post it by hand.
  const announcement = `Announcement: ${ANNOUNCEMENT_LINE[m.announcement]}`;
  lines.push(m.announcement === 'failed' ? `**${announcement}**` : announcement, weekCountLine(m.stage, m.week, m.weekCount));
  return lines.join('\n');
}

// ---- Buttons ----------------------------------------------------------------

// Discord's limit on a custom_id.
export const CUSTOM_ID_LIMIT = 100;

function checked(id: string): string {
  if (id.length > CUSTOM_ID_LIMIT) throw new Error(`custom_id is ${id.length} characters: ${id}`);
  return id;
}

export const saveButtonId = (spreadsheetId: string, gid: string, hash: string) =>
  checked(`msave:${spreadsheetId}:${gid}:${hash}`);
export const cancelButtonId = (hash: string) => checked(`mcancel:${hash}`);

export function parseSaveButtonId(id: string): { spreadsheetId: string; gid: string; hash: string } | undefined {
  const m = /^msave:([\w-]+):(\d+):([0-9a-f]{12})$/.exec(id);
  return m ? { spreadsheetId: m[1], gid: m[2], hash: m[3] } : undefined;
}
