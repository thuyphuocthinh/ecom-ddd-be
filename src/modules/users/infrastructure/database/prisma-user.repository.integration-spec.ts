import { Test, TestingModule } from '@nestjs/testing';
import { PrismaUserRepository } from './prisma-user.repository.js';
import { PrismaService } from '@/core/index.js';

/**
 * Against the real Postgres: the profile changes must touch only their own column. The old way
 * (save the whole user again) would write back a stale copy of the credentials as well.
 */
describe('PrismaUserRepository profile updates (Integration)', () => {
  let repository: PrismaUserRepository;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaUserRepository, PrismaService],
    }).compile();
    repository = module.get(PrismaUserRepository);
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany({ where: { userId: 'u-prof' } });
    await prisma.user.deleteMany({ where: { id: 'u-prof' } });
    await prisma.user.create({
      data: {
        id: 'u-prof',
        displayName: 'Old Name',
        avatarUrl: 'https://old.example.com/a.png',
        role: 'CUSTOMER',
        credentials: {
          create: [
            {
              id: 'cred-prof',
              provider: 'EMAIL',
              identifier: 'prof-test@example.com',
              secret: 'hash-old',
            },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.userCredential.deleteMany({ where: { userId: 'u-prof' } });
    await prisma.user.deleteMany({ where: { id: 'u-prof' } });
    await prisma.$disconnect();
  });

  it('changes only the display name and reports that the user was found', async () => {
    const stale = await repository.findById('u-prof');
    // the password changes after the profile was read ...
    await prisma.userCredential.update({
      where: { id: 'cred-prof' },
      data: { secret: 'hash-new' },
    });

    // ... and a name change made from the stale read must not undo it
    expect(await repository.updateDisplayName(stale!.id, 'New Name')).toBe(
      true,
    );

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: 'u-prof' },
      include: { credentials: true },
    });
    expect(row.displayName).toBe('New Name');
    expect(row.avatarUrl).toBe('https://old.example.com/a.png');
    expect(row.role).toBe('CUSTOMER');
    expect(row.credentials[0].secret).toBe('hash-new');
  });

  it('sets and clears only the avatar address', async () => {
    expect(
      await repository.setAvatarUrl('u-prof', 'https://new.example.com/b.png'),
    ).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: 'u-prof' } }))
        .avatarUrl,
    ).toBe('https://new.example.com/b.png');

    expect(await repository.setAvatarUrl('u-prof', null)).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: 'u-prof' },
    });
    expect(row.avatarUrl).toBeNull();
    expect(row.displayName).toBe('Old Name');
  });

  it('returns false for a user that does not exist, without throwing', async () => {
    expect(await repository.updateDisplayName('nobody', 'x')).toBe(false);
    expect(await repository.setAvatarUrl('nobody', null)).toBe(false);
  });

  it('moves the updated-at time forward', async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: 'u-prof' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await repository.updateDisplayName('u-prof', 'Later');

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: 'u-prof' },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });
});
