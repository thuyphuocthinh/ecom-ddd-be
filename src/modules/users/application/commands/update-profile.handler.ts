import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { UserErrorCodes } from '@/core/index.js';
import { UpdateProfileCommand } from './update-profile.command.js';
import {
  User,
  UserDomainException,
  normalizeDisplayName,
} from '../../domain/index.js';
import type { IUserRepository } from '../../domain/index.js';

@CommandHandler(UpdateProfileCommand)
export class UpdateProfileHandler implements ICommandHandler<
  UpdateProfileCommand,
  User
> {
  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepository,
  ) {}

  async execute(command: UpdateProfileCommand): Promise<User> {
    const displayName = normalizeDisplayName(command.displayName);
    if (displayName === null) {
      throw new UserDomainException(UserErrorCodes.INVALID_DISPLAY_NAME);
    }

    const updated = await this.userRepo.updateDisplayName(
      command.userId,
      displayName,
    );
    return this.reload(command.userId, updated);
  }

  private async reload(userId: string, found: boolean): Promise<User> {
    const user = found ? await this.userRepo.findById(userId) : null;
    if (!user) throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);
    return user;
  }
}
