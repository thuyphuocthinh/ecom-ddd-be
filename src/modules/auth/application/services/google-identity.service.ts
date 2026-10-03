import { Inject, Injectable } from '@nestjs/common';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { googleConfig, type GoogleConfig } from '../../google.config.js';
import {
  AuthDomainException,
  GOOGLE_TOKEN_VERIFIER,
  type GoogleIdentity,
  type IGoogleTokenVerifier,
} from '../../domain/index.js';
import { GoogleTokenStore } from '../../infrastructure/index.js';

/**
 * Turns the ID token a browser got from Google into a person we can trust, or refuses. In order:
 *
 *  1. Sign in with Google must be switched on (a client id is configured).
 *  2. The token must be genuine (signature, issuer, audience, not expired, recently issued).
 *  3. The nonce of the request and of the token must be the same: both absent, or both present and
 *     equal. A token that carries a nonce the request does not know (or the other way round) did not
 *     come from this sign-in. The nonce is a link between the page and the token, not a defence
 *     against replay: that is step 5.
 *  4. Google must say the email is verified: an unverified email proves nothing about who owns it.
 *  5. The token must not have been used before (it works once).
 */
@Injectable()
export class GoogleIdentityService {
  constructor(
    @Inject(googleConfig.KEY) private readonly config: GoogleConfig,
    @Inject(GOOGLE_TOKEN_VERIFIER)
    private readonly verifier: IGoogleTokenVerifier,
    private readonly usedTokens: GoogleTokenStore,
  ) {}

  async authenticate(idToken: string, nonce?: string): Promise<GoogleIdentity> {
    if (this.config.clientIds.length === 0) {
      throw new AuthDomainException(AuthErrorCodes.GOOGLE_NOT_CONFIGURED);
    }

    const identity = await this.verifier.verify(idToken);

    if (identity.nonce !== (nonce || undefined)) {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
    if (!identity.emailVerified) {
      throw new AuthDomainException(AuthErrorCodes.GOOGLE_EMAIL_NOT_VERIFIED);
    }
    if (!(await this.usedTokens.claim(identity.tokenId, identity.expiresAt))) {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
    return identity;
  }

  /** Gives the token back after a failure that is not the person's fault, so they can retry with it. */
  release(identity: GoogleIdentity): Promise<void> {
    return this.usedTokens.release(identity.tokenId);
  }
}
