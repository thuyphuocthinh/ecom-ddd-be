import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { ReinstateUserCommand } from './reinstate-user.command.js';
import { UserErrorCodes } from '@/core/domain/exceptions/error-codes.js';
import {
  UserDomainException,
  type IUserRepository as IUserRepositoryType,
} from '../../../users/domain/index.js';

/** Lets a suspended account log in again. The sessions that were closed stay closed. */
@CommandHandler(ReinstateUserCommand)
export class ReinstateUserHandler implements ICommandHandler<ReinstateUserCommand> {
  private readonly logger = new Logger(ReinstateUserHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepositoryType,
  ) {}

  async execute(command: ReinstateUserCommand): Promise<void> {
    const found = await this.userRepo.setStatus(
      command.userId,
      UserStatus.ACTIVE,
    );
    if (!found) throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);

    this.logger.log(`User ${command.userId} reinstated by ${command.actorId}`);
  }
}
