import { createHash } from 'crypto';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import {
  AuthDomainException,
  type GoogleIdentity,
  type IGoogleTokenVerifier,
} from '../../domain/index.js';

/** Where Google publishes the public keys its ID tokens are signed with. */
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const KEY_FETCH_TIMEOUT_MS = 5_000;
// Google ID tokens live an hour; only a recently issued one is accepted, which shrinks the time
// a stolen token could be used (and each token works only once anyway)
// The library also allows the clock tolerance on top of this, so 9 minutes means "at most about 10"
const MAX_TOKEN_AGE = '9m';
// Google lets its keys be cached for hours; keeping them that long means a short Google outage does
// not stop sign-in (a key that is not in the cache is still fetched at once)
const KEY_CACHE_MS = 6 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 60;

/** Errors that mean "this token is not acceptable", as opposed to "we could not check it". */
const TOKEN_PROBLEMS = [
  errors.JWTInvalid,
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * Checks Google ID tokens with the `jose` library: the signature (RS256 only) against Google's
 * public keys, who issued it, who it is for (one of our client ids), that it has not expired and
 * was issued recently. The keys are fetched from Google and cached by the library. No secret is
 * involved. Tests pass their own `keys` so nothing calls Google.
 */
export class JoseGoogleTokenVerifier implements IGoogleTokenVerifier {
  private readonly logger = new Logger(JoseGoogleTokenVerifier.name);

  constructor(
    private readonly clientIds: string[],
    private readonly keys: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(GOOGLE_CERTS_URL),
      { timeoutDuration: KEY_FETCH_TIMEOUT_MS, cacheMaxAge: KEY_CACHE_MS },
    ),
  ) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.keys, {
        issuer: GOOGLE_ISSUERS,
        audience: this.clientIds,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE,
      }));
    } catch (error) {
      if (TOKEN_PROBLEMS.some((problem) => error instanceof problem)) {
        // A wrong client id is the usual configuration mistake and otherwise leaves no trace: say
        // which claim did not match (never its value, and never the token)
        if (error instanceof errors.JWTClaimValidationFailed) {
          this.logger.warn(
            `A Google token was refused: its "${error.claim}" claim did not match (${error.reason})`,
          );
        }
        throw this.invalid();
      }
      // The keys could not be fetched (network, Google down): not the caller's fault
      this.logger.error(
        `Could not check a Google token: ${(error as Error).name}`,
      );
      throw new ServiceUnavailableException(
        'Google sign-in is temporarily unavailable',
      );
    }
    return this.identityFrom(payload);
  }

  private identityFrom(payload: JWTPayload): GoogleIdentity {
    const { sub, email, email_verified, name, picture, nonce, exp, iat, jti } =
      payload;
    if (
      typeof sub !== 'string' ||
      !sub ||
      typeof email !== 'string' ||
      !email
    ) {
      throw this.invalid();
    }
    if (typeof exp !== 'number' || typeof iat !== 'number') {
      throw this.invalid();
    }
    return {
      sub,
      email: email.trim().toLowerCase(),
      // Google sends a boolean; some tokens carry the string "true"
      emailVerified: email_verified === true || email_verified === 'true',
      name: typeof name === 'string' ? name : undefined,
      picture: typeof picture === 'string' ? picture : undefined,
      nonce: typeof nonce === 'string' ? nonce : undefined,
      expiresAt: new Date(exp * 1000),
      tokenId: createHash('sha256')
        .update(
          JSON.stringify([
            payload.iss,
            payload.aud,
            sub,
            iat,
            exp,
            jti ?? null,
            nonce ?? null,
          ]),
        )
        .digest('hex'),
    };
  }

  private invalid(): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
  }
}
