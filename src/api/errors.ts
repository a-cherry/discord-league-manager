// The API's error body: { error: { code, message } }. The code is for PKTR's
// code, the message for whoever reads its logs.
import type { Response } from 'express';

const STATUS = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  rate_limited: 429,
  internal: 500,
  not_ready: 503,
} as const;

export type ErrorCode = keyof typeof STATUS;

// A query parameter the route doesn't take, or a value it can't use. Answered with 400.
export class BadParameter extends Error {}

export function sendError(res: Response, code: ErrorCode, message: string): void {
  res.status(STATUS[code]).json({ error: { code, message } });
}
