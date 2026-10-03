import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { RemoveAvatarCommand } from './remove-avatar.command.js';
import { IMAGE_STORAGE, LockService } from '@/core/index.js';
import type { IImageStorage } from '@/core/index.js';
import { avatarLock, avatarPath } from '../../domain/index.js';
import type { IUserRepository } from '../../domain/index.js';

@CommandHandler(RemoveAvatarCommand)
export class RemoveAvatarHandler implements ICommandHandler<
  RemoveAvatarCommand,
  void
> {
  private readonly logger = new Logger(RemoveAvatarHandler.name);

  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepository,
    @Inject(IMAGE_STORAGE)
    private readonly storage: IImageStorage,
    private readonly locks: LockService,
  ) {}

  async execute(command: RemoveAvatarCommand): Promise<void> {
    const { userId } = command;
    // Waits for an upload in progress, so the removal always comes after it (see the upload)
    await this.locks.run(avatarLock(userId), async () => {
      // The address is cleared first: that is what the user asked for and sees. A picture left
      // behind in the storage is harmless (the next upload replaces it) and only worth a warning.
      await this.userRepo.setAvatarUrl(userId, null);

      try {
        await this.storage.delete(avatarPath(userId));
      } catch {
        this.logger.warn(
          `The stored picture of user ${userId} could not be removed`,
        );
      }
    });
  }
}
