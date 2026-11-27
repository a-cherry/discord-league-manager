// Trainers rows as the API serves them, and the Discord ID lookup. Pure: no
// Sheets or Discord imports. No Discord ID or username is ever in a resource.
import { playerOrCoach } from '../../roles.js';
import type { Row } from '../../sheet-rows.js';
import type { TrainerIds } from '../ids.js';

export interface TrainerResource {
  id: string;
  nickname: string;
  gym_id: string | null;
  role: 'player' | 'coach';
  leadership: string | null;
  status: string;
  nationality: string | null;
}

export interface Membership {
  trainer_id: string;
  gym_id: string | null;
}

// The statuses the Trainers tab holds. A filter for anything else is a 400.
export const TRAINER_STATUSES = ['active', 'suspended', 'banned', 'inactive'] as const;

// ISO 3166-1 alpha-2, stored in any case. Blank is the opt-out. Anything else
// is served as null, as if blank, rather than send PKTR a value outside the
// contract, and is reported through `warn`. The message names the Trainer by
// nickname and opaque id, never Discord ID.
function nationality(v: Row<'trainers'>, id: string, warn: (message: string) => void): string | null {
  if (!v.country) return null;
  const code = v.country.toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  warn(`Trainers country for ${v.server_nickname} (${id}) is "${v.country}", not a two-letter country code; serving null.`);
  return null;
}

export function mapTrainer(v: Row<'trainers'>, ids: TrainerIds, warn: (message: string) => void = () => {}): TrainerResource {
  const id = ids(v.discord_id);
  return {
    id,
    nickname: v.server_nickname,
    gym_id: v.gym_id || null,
    role: playerOrCoach(v.role),
    leadership: v.leadership === 'none' || !v.leadership ? null : v.leadership,
    status: v.status,
    nationality: nationality(v, id, warn),
  };
}

export const mapTrainers = (rows: Row<'trainers'>[], ids: TrainerIds, warn?: (message: string) => void) =>
  rows.map((v) => mapTrainer(v, ids, warn));

// Discord ID to membership, for /trainers/by-discord. Every Trainers row counts,
// whatever its status: someone who has left keeps their trainer id and history.
export function memberships(rows: Row<'trainers'>[], ids: TrainerIds): Map<string, Membership> {
  const map = new Map<string, Membership>();
  for (const v of rows) {
    if (!map.has(v.discord_id)) map.set(v.discord_id, { trainer_id: ids(v.discord_id), gym_id: v.gym_id || null });
  }
  return map;
}
