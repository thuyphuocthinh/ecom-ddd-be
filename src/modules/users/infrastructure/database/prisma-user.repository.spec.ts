import { describe, it, expect, vi } from 'vitest';
import { Prisma, CredentialProvider } from '@prisma/client';
import { PrismaUserRepository } from './prisma-user.repository.js';
import { User } from '../../domain/index.js';
import { UserErrorCodes } from '@/core/index.js';
import type { PrismaService } from '@/core/index.js';

const buildUser = () => {
  const user = User.create('u1', undefined, 'Test');
  user.addCredential('c1', CredentialProvider.EMAIL, 'a@b.com', 'hash');
  return user;
};

const repoWith = (transaction: ReturnType<typeof vi.fn>) =>
  new PrismaUserRepository({
    $transaction: transaction,
  } as unknown as PrismaService);

describe('PrismaUserRepository.save', () => {
  it('maps a unique-constraint violation (concurrent registration) to EMAIL_ALREADY_EXISTS', async () => {
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`provider`,`identifier`)',
      { code: 'P2002', clientVersion: 'test' },
    );
    const repo = repoWith(vi.fn().mockRejectedValue(uniqueViolation));

    const err = await repo.save(buildUser()).catch((e) => e);

    expect(err.code).toBe(UserErrorCodes.EMAIL_ALREADY_EXISTS.code);
    // the Prisma message (schema details) must not survive into the domain error
    expect(err.message).not.toContain('provider');
  });

  it('rethrows any other database error untouched', async () => {
    const boom = new Error('connection lost');
    const repo = repoWith(vi.fn().mockRejectedValue(boom));

    await expect(repo.save(buildUser())).rejects.toBe(boom);
  });

  it('rethrows other Prisma errors (only P2002 is a conflict)', async () => {
    const other = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const repo = repoWith(vi.fn().mockRejectedValue(other));

    await expect(repo.save(buildUser())).rejects.toBe(other);
  });
});
