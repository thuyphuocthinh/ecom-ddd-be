import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaPasswordRepository } from './prisma-password.repository.js';
import type { PrismaService } from '@/core/index.js';

const NOW = new Date('2026-10-03T10:00:00Z');
const BASE = {
  userId: 'user-1',
  credentialId: 'cred-1',
  newHash: '$argon2id$new',
  now: NOW,
};

describe('PrismaPasswordRepository.changePassword', () => {
  let repo: PrismaPasswordRepository;
  let tx: {
    userCredential: { updateMany: ReturnType<typeof vi.fn> };
    session: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tx = {
      userCredential: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      session: {
        findMany: vi.fn().mockResolvedValue([{ id: 'sid-a' }, { id: 'sid-b' }]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    transaction = vi.fn(async (work: (t: typeof tx) => unknown) => work(tx));
    repo = new PrismaPasswordRepository({
      $transaction: transaction,
    } as unknown as PrismaService);
  });

  it('does the password and the sessions inside ONE transaction', async () => {
    await repo.changePassword({ ...BASE, reason: 'PASSWORD_RESET' });

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.userCredential.updateMany).toHaveBeenCalledOnce();
    expect(tx.session.updateMany).toHaveBeenCalledOnce();
  });

  it('replaces the hash of that one credential of that user, found by id', async () => {
    await repo.changePassword({ ...BASE, reason: 'PASSWORD_RESET' });

    expect(tx.userCredential.updateMany).toHaveBeenCalledWith({
      where: { id: 'cred-1', userId: 'user-1' },
      data: { secret: '$argon2id$new' },
    });
  });

  it('adds the condition "the stored hash is still this one" when asked (AC-15)', async () => {
    await repo.changePassword({
      ...BASE,
      expectedOldHash: '$argon2id$old',
      reason: 'PASSWORD_CHANGED',
    });

    expect(tx.userCredential.updateMany.mock.calls[0][0].where).toEqual({
      id: 'cred-1',
      userId: 'user-1',
      secret: '$argon2id$old',
    });
  });

  it('closes every live session with ONE update, so none can slip in between listing and closing (AC-16)', async () => {
    await repo.changePassword({ ...BASE, reason: 'PASSWORD_RESET' });

    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        revokedAt: null,
        expiresAt: { gt: NOW },
      },
      data: { revokedAt: NOW, revokedReason: 'PASSWORD_RESET' },
    });
  });

  it('returns the ids of the sessions closed just now: those with this time and reason (AC-3)', async () => {
    const result = await repo.changePassword({
      ...BASE,
      reason: 'PASSWORD_RESET',
    });

    expect(tx.session.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        revokedAt: NOW,
        revokedReason: 'PASSWORD_RESET',
      },
      select: { id: true },
    });
    expect(result).toEqual({
      changed: true,
      revokedSessionIds: ['sid-a', 'sid-b'],
    });
  });

  it('spares the session the change was made from (AC-7)', async () => {
    await repo.changePassword({
      ...BASE,
      reason: 'PASSWORD_CHANGED',
      exceptSessionId: 'sid-current',
    });

    expect(tx.session.updateMany.mock.calls[0][0].where.id).toEqual({
      not: 'sid-current',
    });
  });

  it('touches no session when the password was not changed, and says so (AC-15)', async () => {
    tx.userCredential.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.changePassword({
      ...BASE,
      expectedOldHash: '$argon2id$stale',
      reason: 'PASSWORD_CHANGED',
    });

    expect(result).toEqual({ changed: false, revokedSessionIds: [] });
    expect(tx.session.updateMany).not.toHaveBeenCalled();
    expect(tx.session.findMany).not.toHaveBeenCalled();
  });

  it('lets a database error out of the transaction, so nothing is half done (AC-11)', async () => {
    tx.session.updateMany.mockRejectedValue(new Error('db down'));

    await expect(
      repo.changePassword({ ...BASE, reason: 'PASSWORD_RESET' }),
    ).rejects.toThrow('db down');
  });
});
