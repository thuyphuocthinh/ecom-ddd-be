import { Test, TestingModule } from '@nestjs/testing';
import { PrismaCredentialRepository } from './prisma-credential.repository.js';
import { PrismaService } from '@/core/index.js';

/**
 * Against the real Postgres. The point of these two operations is that the DATABASE decides, in
 * one statement, so two requests at the same moment cannot both win. A mock cannot show that.
 */
describe('PrismaCredentialRepository (Integration)', () => {
  let repository: PrismaCredentialRepository;
  let prisma: PrismaService;

  const makeUser = async (
    id: string,
    credentials: Array<{
      provider: 'EMAIL' | 'GOOGLE';
      identifier: string;
      secret: string | null;
    }>,
    profile: { displayName?: string | null; avatarUrl?: string | null } = {},
  ) => {
    await prisma.user.create({
      data: {
        id,
        ...profile,
        credentials: {
          create: credentials.map((c, i) => ({ id: `${id}-c${i}`, ...c })),
        },
      },
    });
  };

  const googleCredentials = (userId: string) =>
    prisma.userCredential.findMany({ where: { userId, provider: 'GOOGLE' } });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaCredentialRepository, PrismaService],
    }).compile();
    repository = module.get(PrismaCredentialRepository);
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany({
      where: { userId: { startsWith: 'u-cred' } },
    });
    await prisma.user.deleteMany({ where: { id: { startsWith: 'u-cred' } } });
  });

  afterAll(async () => {
    await prisma.userCredential.deleteMany({
      where: { userId: { startsWith: 'u-cred' } },
    });
    await prisma.user.deleteMany({ where: { id: { startsWith: 'u-cred' } } });
    await prisma.$disconnect();
  });

  describe('linkGoogle', () => {
    it('adds a Google credential with no secret', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
      ]);

      await expect(repository.linkGoogle('u-cred-1', 'sub-A')).resolves.toBe(
        'LINKED',
      );

      const [google] = await googleCredentials('u-cred-1');
      expect(google.identifier).toBe('sub-A');
      expect(google.secret).toBeNull();
    });

    it('leaves the password of the account exactly as it was', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
      ]);

      await repository.linkGoogle('u-cred-1', 'sub-A');

      const email = await prisma.userCredential.findFirst({
        where: { userId: 'u-cred-1', provider: 'EMAIL' },
      });
      expect(email!.secret).toBe('hash');
    });

    it('says the Google account is taken when it is linked to another user', async () => {
      await makeUser('u-cred-1', [
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);
      await makeUser('u-cred-2', [
        { provider: 'EMAIL', identifier: 'b-cred@example.com', secret: 'hash' },
      ]);

      await expect(repository.linkGoogle('u-cred-2', 'sub-A')).resolves.toBe(
        'SUB_TAKEN',
      );

      expect(await googleCredentials('u-cred-2')).toHaveLength(0);
    });

    it('refuses a second Google account for the same user', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);

      await expect(repository.linkGoogle('u-cred-1', 'sub-B')).resolves.toBe(
        'USER_HAS_GOOGLE',
      );

      const all = await googleCredentials('u-cred-1');
      expect(all.map((c) => c.identifier)).toEqual(['sub-A']);
    });

    it('lets exactly one of two simultaneous links for the same user win (AC-9)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
      ]);

      const results = await Promise.all([
        repository.linkGoogle('u-cred-1', 'sub-A'),
        repository.linkGoogle('u-cred-1', 'sub-B'),
      ]);

      expect(results.filter((r) => r === 'LINKED')).toHaveLength(1);
      expect(await googleCredentials('u-cred-1')).toHaveLength(1);
    });

    it('has the DATABASE refuse a second Google credential for one user, even with the guard in the SQL bypassed (the real protection against a race)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);

      await expect(
        prisma.userCredential.create({
          data: {
            id: 'u-cred-1-second',
            userId: 'u-cred-1',
            provider: 'GOOGLE',
            identifier: 'sub-B',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('lets exactly one of many simultaneous links with different Google accounts win, and the rest are told the user has one (AC-9)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
      ]);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          repository.linkGoogle('u-cred-1', `sub-race-${i}`),
        ),
      );

      expect(results.filter((r) => r === 'LINKED')).toHaveLength(1);
      expect(results.filter((r) => r === 'USER_HAS_GOOGLE')).toHaveLength(7);
      expect(await googleCredentials('u-cred-1')).toHaveLength(1);
    });

    it('lets exactly one of two simultaneous links of the same Google account to different users win', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'h' },
      ]);
      await makeUser('u-cred-2', [
        { provider: 'EMAIL', identifier: 'b-cred@example.com', secret: 'h' },
      ]);

      const results = await Promise.all([
        repository.linkGoogle('u-cred-1', 'sub-A'),
        repository.linkGoogle('u-cred-2', 'sub-A'),
      ]);

      expect(results.filter((r) => r === 'LINKED')).toHaveLength(1);
      expect(results.filter((r) => r === 'SUB_TAKEN')).toHaveLength(1);
    });
  });

  describe('unlinkGoogle', () => {
    it('removes the Google credential when the user still has a password (AC-11)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);

      await expect(repository.unlinkGoogle('u-cred-1')).resolves.toBe(
        'UNLINKED',
      );

      expect(await googleCredentials('u-cred-1')).toHaveLength(0);
      // the password credential is untouched
      expect(
        await prisma.userCredential.count({
          where: { userId: 'u-cred-1', provider: 'EMAIL' },
        }),
      ).toBe(1);
    });

    it('refuses when Google is the only way to log in: the email credential has no password (AC-11)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: null },
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);

      await expect(repository.unlinkGoogle('u-cred-1')).resolves.toBe(
        'LAST_METHOD',
      );

      expect(await googleCredentials('u-cred-1')).toHaveLength(1);
    });

    it('says nothing is linked when there is no Google credential (AC-11)', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
      ]);

      await expect(repository.unlinkGoogle('u-cred-1')).resolves.toBe(
        'NOT_LINKED',
      );
    });

    it('only touches the given user', async () => {
      await makeUser('u-cred-1', [
        { provider: 'EMAIL', identifier: 'a-cred@example.com', secret: 'hash' },
        { provider: 'GOOGLE', identifier: 'sub-A', secret: null },
      ]);
      await makeUser('u-cred-2', [
        { provider: 'EMAIL', identifier: 'b-cred@example.com', secret: 'hash' },
        { provider: 'GOOGLE', identifier: 'sub-B', secret: null },
      ]);

      await repository.unlinkGoogle('u-cred-1');

      expect(await googleCredentials('u-cred-2')).toHaveLength(1);
    });
  });

  describe('fillProfileIfEmpty', () => {
    const profile = {
      displayName: 'Jane Doe',
      avatarUrl: 'https://lh3.googleusercontent.com/a/p',
    };

    it('fills the name and picture of an account that has none', async () => {
      await makeUser('u-cred-1', []);

      await repository.fillProfileIfEmpty('u-cred-1', profile);

      const user = await prisma.user.findUnique({ where: { id: 'u-cred-1' } });
      expect(user!.displayName).toBe('Jane Doe');
      expect(user!.avatarUrl).toBe('https://lh3.googleusercontent.com/a/p');
    });

    it('never overwrites a name or picture the user already has (they may have edited them)', async () => {
      await makeUser('u-cred-1', [], {
        displayName: 'My own name',
        avatarUrl: 'https://example.com/mine.png',
      });

      await repository.fillProfileIfEmpty('u-cred-1', profile);

      const user = await prisma.user.findUnique({ where: { id: 'u-cred-1' } });
      expect(user!.displayName).toBe('My own name');
      expect(user!.avatarUrl).toBe('https://example.com/mine.png');
    });

    it('fills each field on its own', async () => {
      await makeUser('u-cred-1', [], { displayName: 'Kept' });

      await repository.fillProfileIfEmpty('u-cred-1', profile);

      const user = await prisma.user.findUnique({ where: { id: 'u-cred-1' } });
      expect(user!.displayName).toBe('Kept');
      expect(user!.avatarUrl).toBe('https://lh3.googleusercontent.com/a/p');
    });

    it('does nothing for empty values', async () => {
      await makeUser('u-cred-1', []);

      await repository.fillProfileIfEmpty('u-cred-1', {
        displayName: null,
        avatarUrl: null,
      });

      const user = await prisma.user.findUnique({ where: { id: 'u-cred-1' } });
      expect(user!.displayName).toBeNull();
    });
  });
});
