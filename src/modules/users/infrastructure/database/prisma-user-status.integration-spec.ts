import { Test, TestingModule } from '@nestjs/testing';
import { PrismaUserRepository } from './prisma-user.repository.js';
import { PrismaService } from '@/core/index.js';
import { User } from '../../domain/index.js';

/**
 * Against the real Postgres: the status changes must touch only the status, and saving a user
 * (registration, Google sign-in) must never write a stale status back.
 */
describe('PrismaUserRepository status (Integration)', () => {
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
    await prisma.userCredential.deleteMany({ where: { userId: 'u-status' } });
    await prisma.user.deleteMany({ where: { id: 'u-status' } });
    await prisma.user.create({
      data: {
        id: 'u-status',
        displayName: 'Keep Me',
        credentials: {
          create: [
            {
              id: 'cred-status',
              provider: 'EMAIL',
              identifier: 'status-test@example.com',
              secret: 'hash',
            },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.userCredential.deleteMany({ where: { userId: 'u-status' } });
    await prisma.user.deleteMany({ where: { id: 'u-status' } });
    await prisma.$disconnect();
  });

  it('a new account is ACTIVE', async () => {
    expect(await repository.findStatus('u-status')).toBe('ACTIVE');
    expect((await repository.findById('u-status'))!.isActive).toBe(true);
  });

  it('suspends and reinstates, touching only the status', async () => {
    expect(await repository.setStatus('u-status', 'SUSPENDED')).toBe(true);

    const suspended = await repository.findById('u-status');
    expect(suspended!.status).toBe('SUSPENDED');
    expect(suspended!.isActive).toBe(false);
    expect(suspended!.displayName).toBe('Keep Me');
    expect(suspended!.credentials[0].secret).toBe('hash');

    expect(await repository.setStatus('u-status', 'ACTIVE')).toBe(true);
    expect(await repository.findStatus('u-status')).toBe('ACTIVE');
  });

  it('saving a user read before the suspension does not lift it', async () => {
    const stale = await repository.findById('u-status');
    await repository.setStatus('u-status', 'SUSPENDED');

    stale!.displayName = 'Changed Elsewhere';
    await repository.save(stale!);

    expect(await repository.findStatus('u-status')).toBe('SUSPENDED');
  });

  it('a user created through save starts ACTIVE', async () => {
    const created = User.create('u-status-new');
    created.addCredential(
      'cred-status-new',
      'EMAIL',
      'status-new@example.com',
      null,
    );
    try {
      await repository.save(created);

      expect(await repository.findStatus('u-status-new')).toBe('ACTIVE');
    } finally {
      await prisma.userCredential.deleteMany({
        where: { userId: 'u-status-new' },
      });
      await prisma.user.deleteMany({ where: { id: 'u-status-new' } });
    }
  });

  it('answers null and false for a user that does not exist, without throwing', async () => {
    expect(await repository.findStatus('nobody')).toBeNull();
    expect(await repository.setStatus('nobody', 'SUSPENDED')).toBe(false);
  });
});
