import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import {
  IMAGE_STORAGE,
  LockService,
  UserErrorCodes,
  detectImageType,
} from '@/core/index.js';
import type { IImageStorage } from '@/core/index.js';
import { UploadAvatarCommand } from './upload-avatar.command.js';
import {
  AVATAR_FIT,
  AVATAR_MAX_BYTES,
  User,
  UserDomainException,
  avatarLock,
  avatarPath,
} from '../../domain/index.js';
import type { IUserRepository } from '../../domain/index.js';

const refuse = (reason: string) =>
  new UserDomainException(UserErrorCodes.INVALID_AVATAR, { reason });

@CommandHandler(UploadAvatarCommand)
export class UploadAvatarHandler implements ICommandHandler<
  UploadAvatarCommand,
  User
> {
  constructor(
    @Inject('IUserRepository')
    private readonly userRepo: IUserRepository,
    @Inject(IMAGE_STORAGE)
    private readonly storage: IImageStorage,
    private readonly locks: LockService,
  ) {}

  async execute(command: UploadAvatarCommand): Promise<User> {
    const { image, userId } = command;
    // The upload limit already stops big files early; this is the rule itself
    if (!image) throw refuse('Send the picture in the "file" field');
    if (image.length === 0) throw refuse('The file is empty');
    if (image.length > AVATAR_MAX_BYTES) throw refuse('The file is over 2 MB');

    // Decided from the bytes, never from the name or the Content-Type the sender wrote
    const type = detectImageType(image);
    if (!type) throw refuse('Only JPEG, PNG and WebP pictures are accepted');

    // One change to a user's avatar at a time (upload, removal): the stored picture sits at a
    // fixed place, so overlapping steps could leave the address pointing at a deleted picture
    return this.locks.run(avatarLock(userId), async () => {
      // Checked before sending anything, so a picture is not stored for an account that is gone
      if (!(await this.userRepo.findById(userId))) {
        throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);
      }

      const address = await this.storage.upload({
        path: avatarPath(userId),
        image,
        type,
        fit: AVATAR_FIT,
      });

      const saved = await this.userRepo.setAvatarUrl(userId, address);
      const user = saved ? await this.userRepo.findById(userId) : null;
      if (!user) throw new UserDomainException(UserErrorCodes.USER_NOT_FOUND);
      return user;
    });
  }
}
