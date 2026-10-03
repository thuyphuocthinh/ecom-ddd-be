import { Test, TestingModule } from '@nestjs/testing';
import { PrismaPasswordRepository } from './prisma-password.repository.js';
import { PrismaService } from '@/core/index.js';

/**
 * Against the real Postgres: what a mock cannot show is how the database behaves when two
 * changes arrive together, and that the password and the sessions really change as one.
 */
describe('PrismaPasswordRepository (Integration)', () => {
  let repository: PrismaPasswordRepository;
  let prisma: PrismaService;
  const NOW = new Date();
  const LATER = new Date(NOW.getTime() + 60 * 60 * 1000);

  const session = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    userId: 'u-pw',
    refreshTokenHash: `hash-${id}`,
    deviceName: 'test',
    ipAddress: '127.0.0.1',
    lastUsedAt: NOW,
    expiresAt: LATER,
    ...extra,
  });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaPasswordRepository, PrismaService],
    }).compile();
    repository = module.get(PrismaPasswordRepository);
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.session.deleteMany({ where: { userId: 'u-pw' } });
    await prisma.userCredential.deleteMany({ where: { userId: 'u-pw' } });
    await prisma.user.deleteMany({ where: { id: 'u-pw' } });
    await prisma.user.create({
      data: {
        id: 'u-pw',
        credentials: {
          create: [
            {
              id: 'cred-email',
              provider: 'EMAIL',
              identifier: 'pw-test@example.com',
              secret: 'hash-old',
            },
          ],
        },
      },
    });
    await prisma.session.createMany({
      data: [
        session('s-a'),
        session('s-b'),
        session('s-c'),
        // already closed: must stay as it is
        session('s-old', {
          revokedAt: new Date(NOW.getTime() - 1000),
          revokedReason: 'LOGOUT',
        }),
        // already expired: not "live", must not be touched
        session('s-expired', { expiresAt: new Date(NOW.getTime() - 1000) }),
      ],
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: 'u-pw' } });
    await prisma.userCredential.deleteMany({ where: { userId: 'u-pw' } });
    await prisma.user.deleteMany({ where: { id: 'u-pw' } });
    await prisma.$disconnect();
  });

  const params = (over: Record<string, unknown> = {}) => ({
    userId: 'u-pw',
    credentialId: 'cred-email',
    newHash: 'hash-new',
    reason: 'PASSWORD_RESET' as const,
    now: NOW,
    ...over,
  });

  const secret = async () =>
    (await prisma.userCredential.findUnique({ where: { id: 'cred-email' } }))!
      .secret;

  it('replaces the password and closes every live session in one go, with the reason (AC-3)', async () => {
    const result = await repository.changePassword(params());

    expect(result.changed).toBe(true);
    expect(result.revokedSessionIds.sort()).toEqual(['s-a', 's-b', 's-c']);
    expect(await secret()).toBe('hash-new');
    const closed = await prisma.session.findMany({
      where: { revokedReason: 'PASSWORD_RESET' },
    });
    expect(closed.map((row) => row.id).sort()).toEqual(['s-a', 's-b', 's-c']);
  });

  it('leaves alone a session that was already closed and one that has already expired', async () => {
    await repository.changePassword(params());

    const old = await prisma.session.findUnique({ where: { id: 's-old' } });
    expect(old!.revokedReason).toBe('LOGOUT');
    const expired = await prisma.session.findUnique({
      where: { id: 's-expired' },
    });
    expect(expired!.revokedAt).toBeNull();
  });

  it('keeps the session the change is made from open, and closes the others (AC-7)', async () => {
    const result = await repository.changePassword(
      params({ reason: 'PASSWORD_CHANGED', exceptSessionId: 's-a' }),
    );

    expect(result.revokedSessionIds.sort()).toEqual(['s-b', 's-c']);
    const kept = await prisma.session.findUnique({ where: { id: 's-a' } });
    expect(kept!.revokedAt).toBeNull();
  });

  it('writes nothing, sessions included, when the stored hash is not the one that was checked (AC-15)', async () => {
    const result = await repository.changePassword(
      params({ expectedOldHash: 'hash-somebody-else-set' }),
    );

    expect(result).toEqual({ changed: false, revokedSessionIds: [] });
    expect(await secret()).toBe('hash-old');
    expect(
      await prisma.session.count({
        where: { userId: 'u-pw', revokedReason: 'PASSWORD_RESET' },
      }),
    ).toBe(0);
  });

  it('lets exactly one of two simultaneous changes from the same old password win (AC-15)', async () => {
    const results = await Promise.all([
      repository.changePassword(
        params({
          newHash: 'hash-first',
          expectedOldHash: 'hash-old',
          reason: 'PASSWORD_CHANGED',
        }),
      ),
      repository.changePassword(
        params({
          newHash: 'hash-second',
          expectedOldHash: 'hash-old',
          reason: 'PASSWORD_CHANGED',
        }),
      ),
    ]);

    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const winner = results.find((r) => r.changed)!;
    expect(winner.revokedSessionIds.length).toBe(3);
    // the stored password is the winner's, not a mix
    expect(['hash-first', 'hash-second']).toContain(await secret());
  });

  it('only touches the credential it was told to, and only that of this user', async () => {
    await prisma.user.create({ data: { id: 'u-other' } });
    await prisma.userCredential.create({
      data: {
        id: 'cred-other',
        userId: 'u-other',
        provider: 'EMAIL',
        identifier: 'other-pw@example.com',
        secret: 'hash-other',
      },
    });
    try {
      const result = await repository.changePassword(
        params({ credentialId: 'cred-other' }),
      );

      // the credential belongs to another user: nothing changes for either
      expect(result.changed).toBe(false);
      expect(await secret()).toBe('hash-old');
      const other = await prisma.userCredential.findUnique({
        where: { id: 'cred-other' },
      });
      expect(other!.secret).toBe('hash-other');
    } finally {
      await prisma.userCredential.deleteMany({ where: { userId: 'u-other' } });
      await prisma.user.deleteMany({ where: { id: 'u-other' } });
    }
  });
});
