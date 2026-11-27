// API keys and the lookup's rate limit. Keys are stored as SHA-256 hashes in
// env vars (API_KEYS, API_LOOKUP_KEYS), as comma-separated label:sha256hex
// pairs. The label names the key in logs; the key itself is never logged.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { sendError } from './errors.js';

export interface ApiKey {
  label: string;
  hash: Buffer;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Malformed entries are skipped and reported through `warn`, by position, so a
// typo in the env var can't leak a key into the log.
export function parseKeys(raw: string | undefined, warn: (message: string) => void = () => {}): ApiKey[] {
  const keys: ApiKey[] = [];
  (raw ?? '').split(',').forEach((entry, i) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const m = /^([\w.-]+):([0-9a-f]{64})$/i.exec(trimmed);
    if (!m) {
      warn(`entry ${i + 1} is not label:sha256hex; skipped`);
      return;
    }
    if (keys.some((k) => k.label === m[1])) warn(`label ${m[1]} is used twice; they share one rate limit`);
    keys.push({ label: m[1], hash: Buffer.from(m[2], 'hex') });
  });
  return keys;
}

// The key a presented secret matches, if any. Every key is compared, so the
// time taken doesn't say which one came close.
export function findKey(keys: readonly ApiKey[], presented: string): ApiKey | undefined {
  const hash = sha256(presented);
  let found: ApiKey | undefined;
  for (const key of keys) if (timingSafeEqual(key.hash, hash) && !found) found = key;
  return found;
}

// Authorization: Bearer <key>. Never a query string.
export const bearerToken = (header: string | undefined) => /^Bearer +(\S+) *$/i.exec(header ?? '')?.[1];

// Lets the request through with a key from `keys`, recording its label in
// res.locals.keyLabel for the access log; answers 401 otherwise.
export function requireKey(keys: readonly ApiKey[]): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req.get('authorization'));
    if (!token) {
      sendError(res, 'unauthorized', 'Send the API key as Authorization: Bearer <key>.');
      return;
    }
    const key = findKey(keys, token);
    if (!key) {
      sendError(res, 'unauthorized', 'That API key is not valid for this route.');
      return;
    }
    res.locals.keyLabel = key.label;
    next();
  };
}

// At most `limit` requests per key in any `windowMs`, counted in this process:
// exactly one instance runs. A sliding window over request times.
export class RateLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // Counts the request if it's allowed. Otherwise says how many seconds until it would be.
  take(label: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const recent = (this.seen.get(label) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.seen.set(label, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.seen.set(label, recent);
    return { ok: true };
  }
}

// The lookup's limit: 60 an hour per key.
export const LOOKUP_LIMIT = 60;
export const LOOKUP_WINDOW_MS = 60 * 60_000;

// After requireKey: limits by the key's label, answering 429 with Retry-After.
export function rateLimit(limiter: RateLimiter): RequestHandler {
  return (_req, res, next) => {
    const result = limiter.take(res.locals.keyLabel as string);
    if (!result.ok) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      sendError(res, 'rate_limited', `This key is limited to ${LOOKUP_LIMIT} lookups an hour.`);
      return;
    }
    next();
  };
}
