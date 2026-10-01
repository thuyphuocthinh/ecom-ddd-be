import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaService } from '@/core/index.js';
import { PrismaSessionRepository } from './prisma-session.repository.js';
import { Session } from '../../domain/index.js';

const NOW = new Date('2026-09-30T10:00:00Z');
const LIVE = { revokedAt: null, expiresAt: { gt: NOW } };

const buildRow = (overrides = {}) => ({
  id: 'sid-1',
  userId: 'user-1',
  refreshTokenHash: 'hash-1',
  previousRefreshTokenHash: null,
  rotatedAt: null,
  deviceName: 'Chrome',
  ipAddress: '203.0.113.7',
  lastUsedAt: NOW,
  createdAt: NOW,
  expiresAt: new Date('2026-10-07T10:00:00Z'),
  revokedAt: null,
  revokedReason: null,
  ...overrides,
});

describe('PrismaSessionRepository', () => {
  let repo: PrismaSessionRepository;
  let db: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    db = {
      create: vi.fn().mockResolvedValue(undefined),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      session: db,
      $transaction: (fn: (tx: unknown) => unknown) => fn({ session: db }),
    };
    repo = new PrismaSessionRepository(prisma as unknown as PrismaService);
  });

  it('save inserts the session row', async () => {
    const session = new Session(buildRow());

    await repo.save(session);

    expect(db.create).toHaveBeenCalledWith({ data: buildRow() });
  });

  describe('lookups only ever see live sessions (not revoked, not expired)', () => {
    it('findActiveByRefreshHash', async () => {
      db.findFirst.mockResolvedValue(buildRow());

      const session = await repo.findActiveByRefreshHash('hash-1', NOW);

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { refreshTokenHash: 'hash-1', ...LIVE },
      });
      expect(session?.id).toBe('sid-1');
    });

    it('findActiveByPreviousHash', async () => {
      await repo.findActiveByPreviousHash('hash-0', NOW);

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { previousRefreshTokenHash: 'hash-0', ...LIVE },
      });
    });

    it('returns null when nothing matches', async () => {
      await expect(
        repo.findActiveByRefreshHash('nope', NOW),
      ).resolves.toBeNull();
    });

    it("findActiveByUser lists the user's sessions, most recently used first", async () => {
      db.findMany.mockResolvedValue([buildRow(), buildRow({ id: 'sid-2' })]);

      const sessions = await repo.findActiveByUser('user-1', NOW);

      expect(db.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', ...LIVE },
        orderBy: { lastUsedAt: 'desc' },
      });
      expect(sessions.map((s) => s.id)).toEqual(['sid-1', 'sid-2']);
    });
  });

  describe('rotate — the race guard', () => {
    const rotated = () => {
      const session = new Session(buildRow());
      session.rotate({
        newRefreshTokenHash: 'hash-2',
        ipAddress: '198.51.100.9',
        now: NOW,
        refreshTtlSeconds: 604800,
        absoluteTtlSeconds: 2592000,
      });
      return session;
    };

    it('updates only if the stored token is still the expected one and the session is live', async () => {
      await repo.rotate(rotated(), 'hash-1', NOW);

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'sid-1', refreshTokenHash: 'hash-1', ...LIVE },
        data: {
          refreshTokenHash: 'hash-2',
          previousRefreshTokenHash: 'hash-1',
          rotatedAt: NOW,
          ipAddress: '198.51.100.9',
          lastUsedAt: NOW,
          expiresAt: expect.any(Date),
        },
      });
    });

    it('wins (true) when exactly one row was updated', async () => {
      db.updateMany.mockResolvedValue({ count: 1 });
      await expect(repo.rotate(rotated(), 'hash-1', NOW)).resolves.toBe(true);
    });

    it('loses (false) when no row matched — a concurrent request rotated it first', async () => {
      db.updateMany.mockResolvedValue({ count: 0 });
      await expect(repo.rotate(rotated(), 'hash-1', NOW)).resolves.toBe(false);
    });
  });

  describe('revoke', () => {
    it('revokes a live session that belongs to the user, recording when and why', async () => {
      await repo.revoke('sid-1', 'user-1', 'LOGOUT', NOW);

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'sid-1', userId: 'user-1', ...LIVE },
        data: { revokedAt: NOW, revokedReason: 'LOGOUT' },
      });
    });

    it('reports whether something was revoked (false for unknown, foreign or already-closed sessions)', async () => {
      db.updateMany.mockResolvedValue({ count: 1 });
      await expect(repo.revoke('sid-1', 'user-1', 'LOGOUT', NOW)).resolves.toBe(
        true,
      );

      db.updateMany.mockResolvedValue({ count: 0 });
      await expect(repo.revoke('sid-1', 'user-x', 'LOGOUT', NOW)).resolves.toBe(
        false,
      );
    });
  });

  describe('revokeAllForUser', () => {
    it("revokes the user's live sessions and returns their ids", async () => {
      db.findMany.mockResolvedValue([{ id: 'sid-1' }, { id: 'sid-2' }]);

      const ids = await repo.revokeAllForUser('user-1', 'LOGOUT_ALL', NOW);

      expect(db.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', ...LIVE },
        select: { id: true },
      });
      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['sid-1', 'sid-2'] }, revokedAt: null },
        data: { revokedAt: NOW, revokedReason: 'LOGOUT_ALL' },
      });
      expect(ids).toEqual(['sid-1', 'sid-2']);
    });

    it('spares the excepted session', async () => {
      db.findMany.mockResolvedValue([{ id: 'sid-2' }]);

      await repo.revokeAllForUser('user-1', 'LOGOUT_OTHERS', NOW, 'sid-1');

      expect(db.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', ...LIVE, id: { not: 'sid-1' } },
        select: { id: true },
      });
    });

    it('does not run an update when there is nothing to revoke', async () => {
      db.findMany.mockResolvedValue([]);

      await expect(
        repo.revokeAllForUser('user-1', 'LOGOUT_ALL', NOW),
      ).resolves.toEqual([]);
      expect(db.updateMany).not.toHaveBeenCalled();
    });
  });
});
