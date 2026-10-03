import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { SuspendUserCommand } from './suspend-user.command.js';
import {
  AuthErrorCodes,
  UserErrorCodes,
} from '@/core/domain/exceptions/error-codes.js';
import {
  UserDomainException,
  type IUserRepository as IUserRepositoryType,
} from '../../../users/domain/index.js';
import {
  AuthDomainException,
  type ISessionRepository,
} from '../../domain/index.js';
import { TokenStore } from '../../infrastructure/index.js';
import { TokenIssuer } from '../services/token-issuer.service.js';

/**
 * Locks an account out and ends everything it holds. In this order:
 *  1. the status is written, so no NEW login can start;
 *  2. every session is closed in the database, so no refresh token works any more;
 *  3. the token version goes up and the closed sessions are flagged in Redis, so the access
 *     tokens already handed out are refused at once (like "log out everywhere").
 * The database comes before Redis, so calling it again after a Redis failure finishes the job.
 * Asking for an account that is already suspended runs the same steps (nothing is lost).
 *
 * The immediate end of the access tokens depends on Redis keeping its data: if Redis loses the
 * token version, access tokens issued before the suspension work until they expire (15 minutes
 * by default). The refresh tokens are already dead (they live in the database).
 */
@CommandHandler(SuspendUserCommand)
export class SuspendUserHandler implements ICommandHandler<SuspendUserCommand> {
  private readonly logger = new Logger(SuspendUserHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenStore: TokenStore,
    private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(command: SuspendUserCommand): Promise<void> {
    const target = await this.userRepo.findById(command.userId);
    if (!target) throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);
    // An administrator can lock out neither another one nor themselves: lower the role first
    if (target.role === UserRole.ADMIN) {
      throw new AuthDomainException(AuthErrorCodes.ADMIN_CANNOT_BE_SUSPENDED);
    }

    await this.userRepo.setStatus(target.id, UserStatus.SUSPENDED);

    const revokedIds = await this.sessionRepo.revokeAllForUser(
      target.id,
      'ADMIN',
      new Date(),
    );

    await this.endAccessTokens(target.id, revokedIds);

    // Ids only: who did it, to whom, how many sessions were closed
    this.logger.log(
      `User ${target.id} suspended by ${command.actorId}; ${revokedIds.length} session(s) closed`,
    );
  }

  /**
   * The suspension and the closed sessions are already saved. If Redis fails here the answer is
   * 503 (not 500), saying plainly that the request must be repeated: until then the access
   * tokens handed out earlier still work for up to their lifetime.
   */
  private async endAccessTokens(
    userId: string,
    sessionIds: string[],
  ): Promise<void> {
    try {
      await this.tokenStore.bumpTokenVersion(userId);
      await this.tokenStore.markSessionsRevoked(
        sessionIds,
        this.tokenIssuer.accessTtlSeconds,
      );
    } catch (error: any) {
      this.logger.error(
        `User ${userId} is suspended but its access tokens could not be ended: ${error.message}`,
      );
      throw new ServiceUnavailableException(
        'The account is suspended but the suspension is not finished; repeat the request',
      );
    }
  }
}
