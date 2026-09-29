import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Who a request is counted against:
 *  - 'ip'    : client IP (default)
 *  - 'user'  : authenticated user id, falls back to IP on public routes
 *  - function: custom identity, e.g. (req) => `${req.ip}:${req.body?.email}`
 */
export type RateLimitKey =
  'ip' | 'user' | ((req: Request) => string | undefined);

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in seconds — use buildTTL, e.g. buildTTL('MINUTE', 15). */
  window: number;
  /** Who to count against. Defaults to 'ip'. */
  key?: RateLimitKey;
}

/** Limit a route, or every route of a controller (each route gets its own bucket). */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
