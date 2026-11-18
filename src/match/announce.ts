// Posts the match results embed to DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID:
// the winner's emote and bold name, "defeated", the loser's, and the bold score,
// with the embed timestamp.
import { postEmbed, renderEmote, type Embed } from '../discord.js';
import { announcementText, type GymScore } from './format.js';

export function resultsChannelId(): string {
  const id = process.env.DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID is not set');
  return id;
}

// The Discord calls this needs; tests pass stubs.
export interface AnnounceClient {
  renderEmote: (guildId: string, emote: string) => Promise<string>;
  postEmbed: (channelId: string, embed: Embed) => Promise<unknown>;
}

export async function announceResult(
  guildId: string, left: GymScore, right: GymScore, now = new Date(), discord: AnnounceClient = { renderEmote, postEmbed },
): Promise<void> {
  const channelId = resultsChannelId();
  // The Gyms emote column holds :name: as staff type it; a bot message needs
  // <:name:id>. A blank emote stays blank.
  const withEmote = async (g: GymScore) => ({ ...g, emote: g.emote.trim() ? await discord.renderEmote(guildId, g.emote) : '' });
  const [l, r] = await Promise.all([withEmote(left), withEmote(right)]);
  await discord.postEmbed(channelId, { description: announcementText(l, r), timestamp: now.toISOString() });
}
