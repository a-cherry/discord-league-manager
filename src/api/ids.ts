// Opaque trainer ids: the API never shows a Discord ID, so each Trainer is
// t_ + the first 16 base32 characters of HMAC-SHA256(API_ID_SECRET, discord_id).
// Stable for as long as the secret is: never rotate it, or every id changes and
// PKTR loses the link between a Trainer's old and new records.
import { createHmac } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 base32, lowercase

// 16 characters are 80 bits, exactly the first 10 bytes.
function base32(bytes: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export type TrainerIds = (discordId: string) => string;

export const trainerIds = (secret: string): TrainerIds => (discordId) =>
  `t_${base32(createHmac('sha256', secret).update(discordId).digest().subarray(0, 10))}`;
