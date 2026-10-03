import { Inject, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { CACHE } from '@/core/infrastructure/cache/cache.constants.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import { authConfig } from '../../auth.config.js';
import type { AuthConfig } from '../../auth.config.js';
import { AuthDomainException, type OtpPurpose } from '../../domain/index.js';
import { OtpStore } from '../../infrastructure/index.js';

/**
 * One-time codes sent to an email address. Purpose-independent (registration now,
 * password reset later): it only knows how to hand out a code, check one, and limit
 * how often codes are sent.
 *
 * Only a keyed hash of the code is kept (in Redis). A 6-digit code has just a million
 * possibilities, so a plain hash would be reversed instantly by anyone who saw
 * Redis; without the server's key the stored value is useless. The key comes from
 * the JWT secret under its own label, so no extra secret has to be configured.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly key: Buffer;

  constructor(
    @Inject(authConfig.KEY) config: AuthConfig,
    private readonly store: OtpStore,
  ) {
    this.key = Buffer.from(
      HashUtil.hmacSha256(config.jwtSecret, 'otp-v1'),
      'hex',
    );
  }

  /**
   * Asks to send a code to `email`. Throws 429, with `retryAfterSeconds` saying how long
   * to wait, when one was sent within the cooldown (5 minutes)
   * ago or too many went out this hour. The limits apply to every address alike,
   * registered or not, so hitting one says nothing about whether an account exists.
   */
  async reserveSend(purpose: OtpPurpose, email: string): Promise<void> {
    const reservation = await this.store.reserveSend(purpose, email);
    if (reservation.status !== 'RESERVED') {
      // The server knows how long is left, so it tells the client instead of leaving it to guess
      throw new AuthDomainException(AuthErrorCodes.RATE_LIMIT_EXCEEDED, {
        retryAfterSeconds: reservation.retryAfterSeconds,
      });
    }
  }

  /** Gives back the cooldown and hourly slot of a send that did not happen. Best effort. */
  async releaseSend(purpose: OtpPurpose, email: string): Promise<void> {
    try {
      await this.store.releaseSend(purpose, email);
    } catch (error: any) {
      this.logger.warn(`Could not release the send slot: ${error.message}`);
    }
  }

  /** Creates a code for `email` and stores its hash. The raw code is returned once, to be emailed. */
  async issue(purpose: OtpPurpose, email: string): Promise<string> {
    const code = HashUtil.generateOTP(CACHE.AUTH.SETTINGS.OTP_LENGTH);
    await this.store.saveCode(
      purpose,
      email,
      this.digest(purpose, email, code),
    );
    return code;
  }

  /**
   * Checks a guess made by `clientId` (the caller's IP). Every call counts as an attempt:
   * a client gets a few per code and is then refused, and when all clients together pass
   * the total the code is destroyed, so it can't be brute-forced. One client running out
   * of guesses does not touch the code for anyone else. Does not use the code up: call
   * `consume` once the rest of the flow is ready to go ahead.
   */
  async verify(
    purpose: OtpPurpose,
    email: string,
    code: string,
    clientId: string,
  ): Promise<boolean> {
    const entry = await this.store.fetchAndCountAttempt(
      purpose,
      email,
      clientId,
    );
    if (!entry) return false;

    const expected = Buffer.from(entry.hash, 'hex');
    const actual = Buffer.from(this.digest(purpose, email, code), 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /** Uses the code up. True for exactly one of several concurrent callers. */
  consume(purpose: OtpPurpose, email: string): Promise<boolean> {
    return this.store.consume(purpose, email);
  }

  // Bound to the purpose and the address, so a code can't be moved to another use or person
  private digest(purpose: OtpPurpose, email: string, code: string): string {
    return HashUtil.hmacSha256(this.key, `${purpose}:${email}:${code}`);
  }
}
