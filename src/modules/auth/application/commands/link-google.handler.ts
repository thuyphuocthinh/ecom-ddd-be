import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { LinkGoogleCommand } from './link-google.command.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository as IUserRepositoryType } from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type GoogleIdentity,
  type ICredentialRepository,
} from '../../domain/index.js';
import { AccountMailer } from '../services/account-mailer.service.js';
import { GoogleIdentityService } from '../services/google-identity.service.js';
import { profileOf } from '../services/google-profile.js';

/**
 * Links a Google account to the account of the logged-in user.
 *
 * A link is a new way to log in to the account, so a stolen access token alone must not be able
 * to add one (it would survive the owner changing the password). An account that has a password
 * therefore needs the current password here, and the owner is emailed whenever a link is added.
 *
 * The Google email may differ from the account email. It is refused when this Google account
 * belongs to somebody else, or when the user already has a different one.
 */
@CommandHandler(LinkGoogleCommand)
export class LinkGoogleHandler implements ICommandHandler<LinkGoogleCommand> {
  private readonly logger = new Logger(LinkGoogleHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('ICredentialRepository')
    private readonly credentialRepo: ICredentialRepository,
    private readonly identities: GoogleIdentityService,
    private readonly accountMailer: AccountMailer,
  ) {}

  async execute(command: LinkGoogleCommand): Promise<void> {
    const user = await this.userRepo.findById(command.userId);
    if (!user) {
      // The access token outlived the user: nothing to link to
      throw new AuthDomainException(AuthErrorCodes.INVALID_CREDENTIALS);
    }

    // The password first, before the Google token is used up
    const passwordCredential = user.credentials.find(
      (c) => c.provider === CredentialProvider.EMAIL && c.secret,
    );
    if (passwordCredential?.secret) {
      const proven =
        !!command.currentPassword &&
        (await HashUtil.comparePassword(
          command.currentPassword,
          passwordCredential.secret,
        ));
      if (!proven) {
        throw new AuthDomainException(
          AuthErrorCodes.INCORRECT_CURRENT_PASSWORD,
        );
      }
    }

    const identity = await this.identities.authenticate(
      command.idToken,
      command.nonce,
    );
    try {
      const accountEmail = user.credentials.find(
        (c) => c.provider === CredentialProvider.EMAIL,
      )?.identifier;
      await this.link(user, identity, accountEmail);
    } catch (error) {
      // Not the person's fault (the database, say): give the token back so they can try again
      if (!(error instanceof AuthDomainException)) {
        await this.identities.release(identity);
      }
      throw error;
    }
  }

  private async link(
    user: {
      id: string;
      credentials: Array<{ provider: CredentialProvider; identifier: string }>;
    },
    identity: GoogleIdentity,
    accountEmail: string | undefined,
  ): Promise<void> {
    const existing = user.credentials.find(
      (c) => c.provider === CredentialProvider.GOOGLE,
    );
    if (existing) {
      // Linking the same Google account again changes nothing; a different one is refused
      if (existing.identifier === identity.sub) return;
      throw this.conflict();
    }

    const result = await this.credentialRepo.linkGoogle(user.id, identity.sub);
    if (result === 'USER_HAS_GOOGLE') {
      // Another request linked one a moment ago. If it was this very Google account, all is well
      const again = await this.userRepo.findById(user.id);
      const now = again?.credentials.find(
        (c) => c.provider === CredentialProvider.GOOGLE,
      );
      if (now?.identifier === identity.sub) return;
      throw this.conflict();
    }
    if (result !== 'LINKED') {
      throw this.conflict();
    }

    // The link exists: tell the owner first, and let filling in the profile fail without
    // undoing it or hiding the notice
    if (accountEmail) {
      await this.accountMailer.sendGoogleLinked(accountEmail);
    }
    try {
      await this.credentialRepo.fillProfileIfEmpty(
        user.id,
        profileOf(identity),
      );
    } catch (error) {
      this.logger.error(
        `Could not fill in the profile after linking Google: ${(error as Error).name}`,
      );
    }
  }

  private conflict(): AuthDomainException {
    return new AuthDomainException(AuthErrorCodes.GOOGLE_ACCOUNT_CONFLICT);
  }
}
