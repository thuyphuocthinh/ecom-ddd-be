import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  CredentialProvider,
  type UserRole,
  type UserStatus,
} from '@prisma/client';
import { GoogleLoginCommand } from './google-login.command.js';
import {
  AuthErrorCodes,
  UserErrorCodes,
} from '@/core/domain/exceptions/error-codes.js';
import {
  User,
  UserDomainException,
  type IUserRepository as IUserRepositoryType,
} from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type GoogleIdentity,
  type ICredentialRepository,
} from '../../domain/index.js';
import { AccountMailer } from '../services/account-mailer.service.js';
import { GoogleIdentityService } from '../services/google-identity.service.js';
import { profileOf } from '../services/google-profile.js';
import { SessionIssuer } from '../services/session-issuer.service.js';

interface Account {
  user: { id: string; role: UserRole; status: UserStatus };
  isNewUser: boolean;
}

export interface GoogleLoginResult {
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
}

/**
 * Logs a person in with a Google ID token. Who they are is decided in this order:
 *
 *  1. Their Google id (`sub`) is already linked to an account: that account.
 *  2. Another account has the same email: link this Google account to it (the token's email is
 *     verified, and every existing account proved its mailbox too) and tell the owner. If that
 *     account already has a DIFFERENT Google account linked, refuse: an email changing hands must
 *     not hand over the account.
 *  3. Otherwise create an account with a Google credential and an email credential without a
 *     password (so the account keeps its address, and nobody can register that address again).
 *
 * Two first-time requests at once can both reach step 3 or both try to link; the database rejects
 * the second, and the flow is run once more so it finds what the first one made.
 */
@CommandHandler(GoogleLoginCommand)
export class GoogleLoginHandler implements ICommandHandler<GoogleLoginCommand> {
  private readonly logger = new Logger(GoogleLoginHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('ICredentialRepository')
    private readonly credentialRepo: ICredentialRepository,
    private readonly identities: GoogleIdentityService,
    private readonly sessionIssuer: SessionIssuer,
    private readonly accountMailer: AccountMailer,
  ) {}

  async execute(command: GoogleLoginCommand): Promise<GoogleLoginResult> {
    const identity = await this.identities.authenticate(
      command.idToken,
      command.nonce,
    );

    try {
      const { user, isNewUser } = await this.resolveAccount(identity, 0);
      const tokens = await this.sessionIssuer.start(user, command.client);
      return { ...tokens, isNewUser };
    } catch (error) {
      // Not the person's fault (the database, say): give the token back so the same token can be
      // used again, instead of telling them it is invalid. A refusal that is about the account
      // (a conflict) keeps the token used.
      if (!(error instanceof AuthDomainException)) {
        await this.identities.release(identity);
      }
      throw error;
    }
  }

  private async resolveAccount(
    identity: GoogleIdentity,
    attempt: number,
  ): Promise<Account> {
    // 1. Already linked
    const linked = await this.userRepo.findByCredential(
      CredentialProvider.GOOGLE,
      identity.sub,
    );
    if (linked) return { user: this.mustBeActive(linked), isNewUser: false };

    // 2. An account with this email
    const sameEmail = await this.userRepo.findByCredential(
      CredentialProvider.EMAIL,
      identity.email,
    );
    if (sameEmail) {
      return this.linkToExisting(
        this.mustBeActive(sameEmail),
        identity,
        attempt,
      );
    }

    // 3. A new account
    return this.createAccount(identity, attempt);
  }

  /**
   * A suspended account is refused before anything is changed on it: linking Google to it, or
   * sending the owner a notice, would be a change made on behalf of a person who is locked out.
   */
  private mustBeActive(account: User): User {
    if (!account.isActive) {
      throw new AuthDomainException(AuthErrorCodes.ACCOUNT_SUSPENDED);
    }
    return account;
  }

  private async linkToExisting(
    account: User,
    identity: GoogleIdentity,
    attempt: number,
  ): Promise<Account> {
    const hasGoogle = account.credentials.some(
      (c) => c.provider === CredentialProvider.GOOGLE,
    );
    if (hasGoogle) {
      // A Google account is linked already, and it is not this one (step 1 would have found it)
      throw this.conflict();
    }

    const result = await this.credentialRepo.linkGoogle(
      account.id,
      identity.sub,
    );
    if (result === 'LINKED') {
      // The link exists: tell the owner first, and let filling in the profile fail without
      // undoing it or hiding the notice
      await this.accountMailer.sendGoogleLinked(identity.email);
      try {
        await this.credentialRepo.fillProfileIfEmpty(
          account.id,
          profileOf(identity),
        );
      } catch (error) {
        this.logger.error(
          `Could not fill in the profile after linking Google: ${(error as Error).name}`,
        );
      }
      return { user: account, isNewUser: false };
    }
    // Somebody linked this Google account (or gave this account one) a moment ago: look again
    if (attempt === 0) return this.resolveAccount(identity, 1);
    throw this.conflict();
  }

  private async createAccount(
    identity: GoogleIdentity,
    attempt: number,
  ): Promise<Account> {
    const { displayName, avatarUrl } = profileOf(identity);
    const user = User.create(randomUUID(), undefined, displayName, avatarUrl);
    user.addCredential(
      randomUUID(),
      CredentialProvider.GOOGLE,
      identity.sub,
      null,
    );
    user.addCredential(
      randomUUID(),
      CredentialProvider.EMAIL,
      identity.email,
      null,
    );

    try {
      await this.userRepo.save(user);
    } catch (error) {
      // A request at the same moment made the account first: find it instead of failing
      if (
        attempt === 0 &&
        error instanceof UserDomainException &&
        error.code === UserErrorCodes.EMAIL_ALREADY_EXISTS.code
      ) {
        return this.resolveAccount(identity, 1);
      }
      throw error;
    }
    return { user, isNewUser: true };
  }

  private conflict(): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.GOOGLE_ACCOUNT_CONFLICT);
  }
}
