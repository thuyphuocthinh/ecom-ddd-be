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
      // One-time codes sent by email (see auth-verification spec)
      OTP_LENGTH: 6,
      OTP_TTL: buildTTL('MINUTE', 10),

      // Limits per purpose. A code that leads to a password change gets tighter limits than one
      // that only confirms a new account.
      //  perClientAttempts: guesses one client (IP) gets per code before it is locked out of that code
      //  totalAttempts:     guesses from all clients together before the code is destroyed
      //  sendsPerHour:      codes that may be sent to one email address per hour
      OTP_LIMITS: {
        REGISTER_EMAIL: {
          perClientAttempts: 5,
          totalAttempts: 30,
          sendsPerHour: 5,
        },
        RESET_PASSWORD: {
          perClientAttempts: 3,
          totalAttempts: 10,
          sendsPerHour: 3,
        },
      },
      OTP_RESEND_COOLDOWN: buildTTL('MINUTE', 5),

      OTP_SENDS_WINDOW: buildTTL('HOUR', 1),
      PENDING_SIGNUP_TTL: buildTTL('MINUTE', 30), // how long a not-yet-verified registration is kept
    },
    KEYS: {
      // Flag set when a session is revoked so its still-valid access tokens are refused at once
      SESSION_REVOKED: (sessionId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:session_revoked:${sessionId}`,
      TOKEN_VERSION: (userId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:version:${userId}`,
      // `subjectHash` is the sha256 of the (normalised) email, so the address itself never sits in a key
      PENDING_SIGNUP: (subjectHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:pending_signup:${subjectHash}`,
      OTP: (purpose: string, subjectHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:otp:${purpose}:${subjectHash}`,
      OTP_COOLDOWN: (purpose: string, subjectHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:otp_cooldown:${purpose}:${subjectHash}`,
      OTP_SENT: (purpose: string, subjectHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:otp_sent:${purpose}:${subjectHash}`,
      // Marks a Google ID token as used (`tokenHash` is the sha256 of the token)
      GOOGLE_TOKEN: (tokenHash: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:auth:${CACHE.AUTH._VER}:google_token:${tokenHash}`,
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
  INVENTORY: {
    _VER: 'v1',
    SETTINGS: {
      // How long the "being held" record of an order survives if nobody finishes or undoes it
      // (the process died between Redis and Postgres). Far longer than any repair delay.
      INFLIGHT_RECORD_TTL: buildTTL('HOUR', 1),
    },
    KEYS: {
      // Units of a SKU that can be sold right now. Only Redis holds this number; it is rebuilt
      // from Postgres (onHand minus the units held) when the key is missing.
      AVAILABLE: (skuId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:inventory:${CACHE.INVENTORY._VER}:available:${skuId}`,
      // "This order is being held right now": exists from the Redis deduction until Postgres has
      // the reservation. Stops a duplicate request and lets a repair job find a hold that leaked.
      INFLIGHT: (orderId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:inventory:${CACHE.INVENTORY._VER}:inflight:${orderId}`,
      // Sorted set of the orders being held, scored by the moment (milliseconds, Redis clock)
      // they started. Lets the repair job find the old ones without scanning keys.
      INFLIGHT_INDEX: `${GLOBAL_PREFIX}:${GLOBAL_VER}:inventory:v1:inflight_index`,
    },
  },
  CART: {
    _VER: 'v1',
    SETTINGS: {
      // A cart nobody changed for this long disappears; every change starts the time again
      TTL: buildTTL('DAY', 30),
    },
    KEYS: {
      // One Redis hash per user: a field per SKU, its value a small JSON with the quantity, the
      // price when it was put in and the moment it was first put in (see the cart module)
      CART: (userId: string) =>
        `${GLOBAL_PREFIX}:${GLOBAL_VER}:cart:${CACHE.CART._VER}:user:${userId}`,
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
