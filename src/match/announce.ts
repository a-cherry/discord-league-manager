// Posts the match results embed to DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID:
// the winner's emote and bold name, "defeated", the loser's, and the bold score,
// with the embed timestamp.
import { postEmbed, renderEmote } from '../discord.js';
import { announcementText, type GymScore } from './format.js';

export function resultsChannelId(): string {
  const id = process.env.DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID;
  if (!id) throw new Error('DISCORD_MATCH_RESULTS_ANNOUNCEMENTS_CHANNEL_ID is not set');
  return id;
}

// The Gyms emote column holds :name: as staff type it; a bot message needs
// <:name:id>. A blank emote stays blank.
async function withEmote(guildId: string, g: GymScore): Promise<GymScore> {
  return { ...g, emote: g.emote.trim() ? await renderEmote(guildId, g.emote) : '' };
}

export async function announceResult(guildId: string, left: GymScore, right: GymScore, now = new Date()): Promise<void> {
  const [l, r] = await Promise.all([withEmote(guildId, left), withEmote(guildId, right)]);
  await postEmbed(resultsChannelId(), { description: announcementText(l, r), timestamp: now.toISOString() });
}
