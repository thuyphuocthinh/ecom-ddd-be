import { Test, TestingModule } from '@nestjs/testing';
import { LockService } from './lock.service.js';
import { RedisService } from '../redis.service.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Against the real Redis: what matters is how two callers behave when they arrive together. */
describe('LockService (Integration)', () => {
  let locks: LockService;
  let redis: RedisService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LockService, RedisService],
    }).compile();
    locks = module.get(LockService);
    redis = module.get(RedisService);
  });

  beforeEach(async () => {
    const keys = await redis.getClient().keys('*:lock:*');
    if (keys.length > 0) await redis.getClient().del(...keys);
  });

  afterAll(async () => {
    await redis.getClient().quit();
  });

  it('runs the work and returns its result', async () => {
    await expect(locks.run('t-1', async () => 42)).resolves.toBe(42);
  });

  it('makes two callers for the same name take turns, never overlap', async () => {
    const events: string[] = [];
    const job = (label: string) => async () => {
      events.push(`${label} start`);
      await sleep(150);
      events.push(`${label} end`);
    };

    await Promise.all([locks.run('t-2', job('a')), locks.run('t-2', job('b'))]);

    expect(events).toHaveLength(4);
    // whoever started first also ended before the other started
    expect(events[1]).toMatch(/end$/);
    expect(events[1].split(' ')[0]).toBe(events[0].split(' ')[0]);
  });

  it('lets different names run at the same time', async () => {
    const started: string[] = [];
    const job = (label: string) => async () => {
      started.push(label);
      await sleep(200);
    };

    const begin = Date.now();
    await Promise.all([
      locks.run('t-3a', job('a')),
      locks.run('t-3b', job('b')),
    ]);

    expect(Date.now() - begin).toBeLessThan(380);
  });

  it('gives up with a 409 when the other one takes too long', async () => {
    const holder = locks.run('t-4', () => sleep(400));

    await expect(
      locks.run('t-4', async () => 'never', { waitMs: 100 }),
    ).rejects.toMatchObject({ code: 'SYS-002', status: 409 });

    await holder;
  });

  it('lets go when the work fails, so the next caller is not stuck', async () => {
    await expect(
      locks.run('t-5', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      locks.run('t-5', async () => 'ok', { waitMs: 100 }),
    ).resolves.toBe('ok');
  });

  it('frees itself when the holder disappears (the time limit)', async () => {
    await redis
      .getClient()
      .set('ecom:v1:lock:t-6', 'crashed-holder', 'PX', 100);

    await expect(
      locks.run('t-6', async () => 'ok', { waitMs: 1000 }),
    ).resolves.toBe('ok');
  });

  it('does not release a lock that expired and now belongs to somebody else', async () => {
    await locks.run(
      't-7',
      async () => {
        await sleep(150); // longer than the time limit below: the lock expires meanwhile
        await redis
          .getClient()
          .set('ecom:v1:lock:t-7', 'new-owner', 'PX', 5000);
      },
      { ttlMs: 50 },
    );

    expect(await redis.getClient().get('ecom:v1:lock:t-7')).toBe('new-owner');
  });
});
