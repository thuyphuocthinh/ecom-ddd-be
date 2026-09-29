import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RegisterHandler } from './register.handler.js';
import { RegisterCommand } from './register.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import { UserErrorCodes } from '@/core/index.js';
import { User } from '../../../users/domain/index.js';
import { CredentialProvider } from '@prisma/client';

describe('RegisterHandler', () => {
  let handler: RegisterHandler;
  let userRepo: {
    findByCredential: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    userRepo = {
      findByCredential: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    handler = new RegisterHandler(userRepo as unknown as IUserRepository);
  });

  it('throws EMAIL_ALREADY_EXISTS when email is taken', async () => {
    userRepo.findByCredential.mockResolvedValue({ id: 'existing-user' });

    await expect(
      handler.execute(
        new RegisterCommand('taken@example.com', 'password123', undefined),
      ),
    ).rejects.toSatisfy(
      (e: any) => e.code === UserErrorCodes.EMAIL_ALREADY_EXISTS.code,
    );
    expect(userRepo.save).not.toHaveBeenCalled();
  });

  it('does not expose the email in the error detail when registration fails due to conflict', async () => {
    userRepo.findByCredential.mockResolvedValue({ id: 'existing-user' });

    await expect(
      handler.execute(
        new RegisterCommand('secret@example.com', 'password123', undefined),
      ),
    ).rejects.toSatisfy(
      (e: any) =>
        !JSON.stringify(e.details ?? '').includes('secret@example.com'),
    );
  });

  it('hashes password, creates User with EMAIL credential and saves to repo', async () => {
    userRepo.findByCredential.mockResolvedValue(null);

    const result = await handler.execute(
      new RegisterCommand('new@example.com', 'password123', 'Test User'),
    );

    expect(userRepo.save).toHaveBeenCalledOnce();
    expect(result).toBeInstanceOf(User);

    const savedUser = result as User;
    const emailCredential = savedUser.credentials.find(
      (c) => c.provider === CredentialProvider.EMAIL,
    );
    expect(emailCredential).toBeDefined();
    // Password must be hashed — never stored as plaintext
    expect(emailCredential!.secret).not.toBe('password123');
    expect(emailCredential!.secret!.length).toBeGreaterThan(20);
  });
});
