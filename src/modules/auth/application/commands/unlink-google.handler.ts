import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { UnlinkGoogleCommand } from './unlink-google.command.js';
import { AuthErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import {
  AuthDomainException,
  type ICredentialRepository,
} from '../../domain/index.js';

/**
 * Removes the Google account from the logged-in user's account, unless that would leave no way to
 * log in. The check and the removal are one database statement, so two requests at the same time
 * cannot remove every way in.
 */
@CommandHandler(UnlinkGoogleCommand)
export class UnlinkGoogleHandler implements ICommandHandler<UnlinkGoogleCommand> {
  constructor(
    @Inject('ICredentialRepository')
    private readonly credentialRepo: ICredentialRepository,
  ) {}

  async execute(command: UnlinkGoogleCommand): Promise<void> {
    const result = await this.credentialRepo.unlinkGoogle(command.userId);

    if (result === 'NOT_LINKED') {
      throw new AuthDomainException(AuthErrorCodes.GOOGLE_NOT_LINKED);
    }
    if (result === 'LAST_METHOD') {
      throw new AuthDomainException(AuthErrorCodes.LAST_LOGIN_METHOD);
    }
  }
}
