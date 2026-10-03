import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { UpdateProfileHandler } from './update-profile.handler.js';
import { UpdateProfileCommand } from './update-profile.command.js';
import { UploadAvatarHandler } from './upload-avatar.handler.js';
import { UploadAvatarCommand } from './upload-avatar.command.js';
import { RemoveAvatarHandler } from './remove-avatar.handler.js';
import { RemoveAvatarCommand } from './remove-avatar.command.js';
import { UserErrorCodes } from '@/core/index.js';
import type { IImageStorage, LockService } from '@/core/index.js';
import { AVATAR_MAX_BYTES, User } from '../../domain/index.js';
import type { IUserRepository } from '../../domain/index.js';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: any) => e.code ?? e.constructor.name,
  );

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100),
]);

describe('profile handlers', () => {
  let userRepo: {
    findById: ReturnType<typeof vi.fn>;
    updateDisplayName: ReturnType<typeof vi.fn>;
    setAvatarUrl: ReturnType<typeof vi.fn>;
  };
  let storage: {
    upload: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let warnings: string[];
  let lockedNames: string[];
  // Runs the work at once, remembering which lock was asked for
  const locks = {
    run: async (name: string, work: () => Promise<unknown>) => {
      lockedNames.push(name);
      return work();
    },
  } as unknown as LockService;

  beforeEach(() => {
    vi.restoreAllMocks();
    warnings = [];
    lockedNames = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warnings.push(String(m));
    });
    userRepo = {
      findById: vi.fn().mockResolvedValue(User.create('u-1')),
      updateDisplayName: vi.fn().mockResolvedValue(true),
      setAvatarUrl: vi.fn().mockResolvedValue(true),
    };
    storage = {
      upload: vi.fn().mockResolvedValue('https://res.cloudinary.com/c/a.png'),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('UpdateProfileHandler', () => {
    const handler = () =>
      new UpdateProfileHandler(userRepo as unknown as IUserRepository);

    it('stores the cleaned name for this user and returns the fresh profile (AC-2)', async () => {
      const user = await handler().execute(
        new UpdateProfileCommand('u-1', '  Jane \n  Doe '),
      );

      expect(userRepo.updateDisplayName).toHaveBeenCalledWith(
        'u-1',
        'Jane Doe',
      );
      expect(user.id).toBe('u-1');
    });

    it.each(['', '   ', '​', 'a'.repeat(101)])(
      'refuses %j with USR-006 and changes nothing (AC-3)',
      async (name) => {
        expect(
          await code(handler().execute(new UpdateProfileCommand('u-1', name))),
        ).toBe(UserErrorCodes.INVALID_DISPLAY_NAME.code);
        expect(userRepo.updateDisplayName).not.toHaveBeenCalled();
      },
    );

    it('answers USR-001 when the user no longer exists', async () => {
      userRepo.updateDisplayName.mockResolvedValue(false);

      expect(
        await code(handler().execute(new UpdateProfileCommand('u-1', 'Jane'))),
      ).toBe(UserErrorCodes.USER_NOT_FOUND.code);
    });
  });

  describe('UploadAvatarHandler', () => {
    const handler = () =>
      new UploadAvatarHandler(
        userRepo as unknown as IUserRepository,
        storage as unknown as IImageStorage,
        locks,
      );
    const upload = (image: Buffer | undefined) =>
      handler().execute(new UploadAvatarCommand('u-1', image));

    it('sends a real picture to the storage and keeps the address it gives back (AC-4)', async () => {
      await upload(PNG);

      expect(storage.upload).toHaveBeenCalledWith({
        path: 'avatars/u-1',
        image: PNG,
        type: 'png',
        fit: { width: 256, height: 256, crop: 'fill', focus: 'face' },
      });
      expect(userRepo.setAvatarUrl).toHaveBeenCalledWith(
        'u-1',
        'https://res.cloudinary.com/c/a.png',
      );
    });

    it.each([
      ['no file', undefined],
      ['an empty file', Buffer.alloc(0)],
      ['text pretending to be a picture', Buffer.from('I am just text')],
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      [
        'a picture over 2 MB',
        Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]),
      ],
    ])(
      'refuses %s with USR-003 and sends nothing anywhere (AC-5)',
      async (_name, image) => {
        expect(await code(upload(image))).toBe(
          UserErrorCodes.INVALID_AVATAR.code,
        );

        expect(storage.upload).not.toHaveBeenCalled();
        expect(userRepo.setAvatarUrl).not.toHaveBeenCalled();
      },
    );

    it('accepts a picture of exactly 2 MB', async () => {
      const exact = Buffer.concat([
        PNG,
        Buffer.alloc(AVATAR_MAX_BYTES - PNG.length),
      ]);
      expect(exact.length).toBe(AVATAR_MAX_BYTES);

      await expect(upload(exact)).resolves.toBeDefined();
    });

    it('works under the lock of this user, so it cannot overlap a removal', async () => {
      await upload(PNG);

      expect(lockedNames).toEqual(['avatar:u-1']);
    });

    it('stores nothing for an account that no longer exists', async () => {
      userRepo.findById.mockResolvedValue(null);

      expect(await code(upload(PNG))).toBe(UserErrorCodes.USER_NOT_FOUND.code);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('does not take the lock for a file it refuses anyway', async () => {
      await code(upload(Buffer.from('text')));

      expect(lockedNames).toEqual([]);
    });

    it('keeps the old address when the storage fails (AC-8)', async () => {
      storage.upload.mockRejectedValue(
        Object.assign(new Error('x'), { code: 'STO-002' }),
      );

      expect(await code(upload(PNG))).toBe('STO-002');
      expect(userRepo.setAvatarUrl).not.toHaveBeenCalled();
    });

    it('answers USR-001 when the user no longer exists', async () => {
      userRepo.setAvatarUrl.mockResolvedValue(false);

      expect(await code(upload(PNG))).toBe(UserErrorCodes.USER_NOT_FOUND.code);
    });
  });

  describe('RemoveAvatarHandler', () => {
    const handler = () =>
      new RemoveAvatarHandler(
        userRepo as unknown as IUserRepository,
        storage as unknown as IImageStorage,
        locks,
      );

    it('works under the same lock as the upload, so it waits for one in progress', async () => {
      await handler().execute(new RemoveAvatarCommand('u-1'));

      expect(lockedNames).toEqual(['avatar:u-1']);
    });

    it('clears the address and removes the stored picture (AC-7)', async () => {
      await handler().execute(new RemoveAvatarCommand('u-1'));

      expect(userRepo.setAvatarUrl).toHaveBeenCalledWith('u-1', null);
      expect(storage.delete).toHaveBeenCalledWith('avatars/u-1');
    });

    it('still succeeds, with a warning, when the storage cannot remove the picture', async () => {
      storage.delete.mockRejectedValue(new Error('storage down'));

      await expect(
        handler().execute(new RemoveAvatarCommand('u-1')),
      ).resolves.toBeUndefined();

      expect(userRepo.setAvatarUrl).toHaveBeenCalledWith('u-1', null);
      expect(warnings.join('\n')).toContain('could not be removed');
    });

    it('does not touch the storage when clearing the address failed', async () => {
      userRepo.setAvatarUrl.mockRejectedValue(new Error('db down'));

      await expect(
        handler().execute(new RemoveAvatarCommand('u-1')),
      ).rejects.toThrow('db down');
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });
});
