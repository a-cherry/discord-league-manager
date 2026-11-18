// Which handler takes a button press, by custom_id prefix, and the line that
// replaces the message's buttons while it's worked on (none: the message is
// left alone until the handler answers).
import { handleDisbandButton } from './commands/gym.js';
import { handleMatchCancel, handleMatchSave, MATCH_SAVING } from './commands/match.js';
import type { ComponentHandler } from './interactions.js';
import { handleDecision } from './roster/approval.js';
import { CARD_PROCESSING } from './roster/requests.js';

export interface ComponentRoute {
  handler: ComponentHandler;
  pending?: string;
}

export function componentRoute(customId: string): ComponentRoute | undefined {
  // Approve and Reject on staff approval cards.
  if (/^(approve|reject):/.test(customId)) return { handler: handleDecision, pending: CARD_PROCESSING };
  // The two confirm prompts of /gym disband.
  if (customId.startsWith('disband:')) return { handler: handleDisbandButton };
  // Save and Cancel on a /match submit warnings post. Save takes the buttons
  // off at once, so a second press can't start a second save.
  if (customId.startsWith('msave:')) return { handler: handleMatchSave, pending: MATCH_SAVING };
  if (customId.startsWith('mcancel:')) return { handler: handleMatchCancel };
  return undefined;
}
