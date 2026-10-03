import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  IdempotencyService,
  computeIdempotencyFingerprint,
} from './idempotency.service.js';
import type { RedisService } from '../redis.service.js';

describe('IdempotencyService', () => {
  let redisClient: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let redisService: Pick<RedisService, 'getClient'>;
  let service: IdempotencyService;

  beforeEach(() => {
    redisClient = {
      set: vi.fn(),
      get: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
    };
    redisService = { getClient: () => redisClient as any };
    service = new IdempotencyService(redisService as RedisService);
  });

  it('runs the action directly when no idempotency key is given', async () => {
    const action = vi.fn().mockResolvedValue('result');

    const result = await service.execute(undefined, 'fp', action);

    expect(result).toBe('result');
    expect(action).toHaveBeenCalledOnce();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('claims the key, runs the action once, and marks it completed', async () => {
    redisClient.set.mockResolvedValueOnce('OK');
    const action = vi.fn().mockResolvedValue({ id: '1' });

    const result = await service.execute('key-1', 'fp-1', action);

    expect(result).toEqual({ id: '1' });
    expect(action).toHaveBeenCalledOnce();
    expect(redisClient.set).toHaveBeenCalledTimes(2);
    const completedCall = redisClient.set.mock.calls[1];
    expect(JSON.parse(completedCall[1])).toMatchObject({
      status: 'completed',
      fingerprint: 'fp-1',
      response: { id: '1' },
    });
  });

  it('replays the cached response on retry with the same fingerprint after completion', async () => {
    redisClient.set.mockResolvedValueOnce(null); // NX claim fails: key already exists
    redisClient.get.mockResolvedValueOnce(
      JSON.stringify({
        status: 'completed',
        fingerprint: 'fp-1',
        response: { id: '1' },
      }),
    );
    const action = vi.fn();

    const result = await service.execute('key-1', 'fp-1', action);

    expect(result).toEqual({ id: '1' });
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects a retry with the same key while still processing', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    redisClient.get.mockResolvedValueOnce(
      JSON.stringify({ status: 'processing', fingerprint: 'fp-1' }),
    );
    const action = vi.fn();

    await expect(service.execute('key-1', 'fp-1', action)).rejects.toThrow(
      ConflictException,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('rejects a retry that reuses the key with a different fingerprint', async () => {
    redisClient.set.mockResolvedValueOnce(null);
    redisClient.get.mockResolvedValueOnce(
      JSON.stringify({
        status: 'completed',
        fingerprint: 'fp-1',
        response: { id: '1' },
      }),
    );
    const action = vi.fn();

    await expect(service.execute('key-1', 'fp-2', action)).rejects.toThrow(
      ConflictException,
    );
    expect(action).not.toHaveBeenCalled();
  });

  it('deletes the claim and rethrows if the action fails', async () => {
    redisClient.set.mockResolvedValueOnce('OK');
    const action = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(service.execute('key-1', 'fp-1', action)).rejects.toThrow(
      'boom',
    );
    expect(redisClient.del).toHaveBeenCalledWith('idempotency:key-1');
  });

  it('runs the action unprotected if claiming the lock fails (Redis unavailable)', async () => {
    redisClient.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const action = vi.fn().mockResolvedValue('ok-anyway');

    const result = await service.execute('key-1', 'fp-1', action);

    expect(result).toBe('ok-anyway');
    expect(action).toHaveBeenCalledOnce();
  });

  it('still returns the response if marking completion fails', async () => {
    redisClient.set
      .mockResolvedValueOnce('OK') // claim succeeds
      .mockRejectedValueOnce(new Error('write failed')); // completion write fails
    const action = vi.fn().mockResolvedValue('done');

    const result = await service.execute('key-1', 'fp-1', action);

    expect(result).toBe('done');
  });
});

describe('computeIdempotencyFingerprint', () => {
  it('produces the same hash for the same payload', () => {
    expect(computeIdempotencyFingerprint({ a: 1 })).toBe(
      computeIdempotencyFingerprint({ a: 1 }),
    );
  });

  it('produces a different hash for a different payload', () => {
    expect(computeIdempotencyFingerprint({ a: 1 })).not.toBe(
      computeIdempotencyFingerprint({ a: 2 }),
    );
  });
});
