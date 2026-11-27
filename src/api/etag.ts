// ETags for list responses. The hash covers `data`, not `meta`: meta.as_of
// moves on every refresh, so hashing it would give PKTR a new ETag each minute
// and a 304 would never happen.
import { createHash } from 'node:crypto';

export const etagOf = (data: unknown) =>
  `"${createHash('sha256').update(JSON.stringify(data)).digest('base64url').slice(0, 32)}"`;

// If-None-Match is a list of ETags, or *. A weak W/ prefix still matches: the
// comparison for a 304 is the weak one (RFC 9110, 13.1.2).
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}
