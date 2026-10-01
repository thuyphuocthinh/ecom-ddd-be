const GLOBAL_PREFIX = 'ecom';
const GLOBAL_VER = 'v1';

import { buildTTL } from '../../utils/ttl.util.js';

/**
 * Semantic TTL constants (in seconds).
 * Pick based on data volatility — see comment block at the bottom of this file.
 */
export const TTL = {
  TINY: buildTTL('MINUTE', 1), // highly volatile (stock count, live price)
  SHORT: buildTTL('MINUTE', 5), // semi-volatile (product / category detail)
  MEDIUM: buildTTL('HOUR', 1), // semi-static (user profile, settings)
  LONG: buildTTL('DAY', 1), // static (lookup tables, config)
  WEEK: buildTTL('DAY', 7), // almost never changes
} as const;

/**
 * Centralised cache-key factories.
 *
 * Key format:  <prefix>:<global-ver>:<domain>:<domain-ver>:<type>:<field>_<value>
 * Example:     ecom:v1:catalog:v1:product:id_01J8...
 *
 * Why a domain _VER?
 *   Bumping CATALOG._VER instantly logically invalidates every key under
 *   that domain without touching Redis — old keys just expire naturally.
 *
 * Why TRACKERS?
 *   List caches embed a version counter in their key.  Incrementing the
 *   tracker key forces a cache miss on the next list read without having
 *   to enumerate every cached page.
 */
export const CACHE = {
  CATALOG: {
    _VER: 'v1',

    KEYS: {
      PRODUCT_DETAIL: (id: string): string =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:catalog:${CACHE.CATALOG._VER}:product:id_${id}`,

      CATEGORY_DETAIL: (id: string): string =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:catalog:${CACHE.CATALOG._VER}:category:id_${id}`,
    },
  },
  AUTH: {
    _VER: 'v1',
    SETTINGS: {
      ROTATION_GRACE_TTL: buildTTL('SECOND', 15), // grace window cho concurrent refresh
    },
    KEYS: {
      // Flag set when a session is revoked so its still-valid access tokens are refused at once
      SESSION_REVOKED: (sessionId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:session_revoked:${sessionId}`,
      TOKEN_VERSION: (userId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:version:${userId}`,
      ROTATION_GRACE: (tokenHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:rotation_grace:${tokenHash}`,
    },
  },
  RATE_LIMIT: {
    _VER: 'v1',
    KEYS: {
      // route: Express route pattern (e.g. /auth/login), identifier: e.g. ip:1.1.1.1
      BUCKET: (route: string, identifier: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:ratelimit:${CACHE.RATE_LIMIT._VER}:${route}:${identifier}`,
    },
  },
} as const;

/*
 * ── Cache TTL guidelines ───────────────────────────────────────────────────
 *
 * 1. Data volatility
 *    • Static (config, lookup tables)        → LONG / WEEK
 *    • Semi-static (product detail, profile)  → MEDIUM / SHORT
 *    • Highly volatile (price, stock)         → TINY / SHORT, avoid tags
 *
 * 2. List vs detail TTL
 *    • List keys   → shorter TTL (10–30 min) or version-tracked
 *    • Detail keys → longer TTL, invalidated on write
 *
 * 3. Avoid thundering-herd / cache stampede
 *    Add random jitter when setting TTL:
 *      const jitter = Math.floor(Math.random() * 60);  // 0–60 s
 *      redis.set(key, value, TTL.SHORT + jitter);
 *
 * 4. Stale data
 *    Always invalidate (redis.invalidateDetail) immediately after a
 *    successful write so the next read gets fresh data.
 * ──────────────────────────────────────────────────────────────────────────
 */
