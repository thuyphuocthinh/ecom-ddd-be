import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { UserRole, UserStatus } from '@prisma/client';
import { SuspendUserHandler } from './suspend-user.handler.js';
import { SuspendUserCommand } from './suspend-user.command.js';
import { ReinstateUserHandler } from './reinstate-user.handler.js';
import { ReinstateUserCommand } from './reinstate-user.command.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type { ISessionRepository } from '../../domain/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from '../services/token-issuer.service.js';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: any) => e.code ?? e.constructor.name,
  );

describe('SuspendUserHandler', () => {
  let handler: SuspendUserHandler;
  let calls: string[];
  let userRepo: {
    findById: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
  let sessionRepo: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let tokenStore: {
    bumpTokenVersion: ReturnType<typeof vi.fn>;
    markSessionsRevoked: ReturnType<typeof vi.fn>;
  };
  let logs: string[];
  const suspend = () =>
    handler.execute(new SuspendUserCommand('user-9', 'admin-1'));

  beforeEach(() => {
    logs = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
      logs.push(String(m));
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    calls = [];
    userRepo = {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'user-9', role: UserRole.CUSTOMER }),
      setStatus: vi.fn().mockImplementation(async () => {
        calls.push('write status');
        return true;
      }),
    };
    sessionRepo = {
      revokeAllForUser: vi.fn().mockImplementation(async () => {
        calls.push('close sessions');
        return ['sid-1', 'sid-2'];
      }),
    };
    tokenStore = {
      bumpTokenVersion: vi.fn().mockImplementation(async () => {
        calls.push('bump version');
      }),
      markSessionsRevoked: vi.fn().mockImplementation(async () => {
        calls.push('flag sessions');
      }),
    };
    handler = new SuspendUserHandler(
      userRepo as unknown as IUserRepository,
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      { accessTtlSeconds: 900 } as unknown as TokenIssuer,
    );
  });

  it('writes the status, closes every session as ADMIN, then ends the access tokens, in that order (AC-1)', async () => {
    await suspend();

    expect(userRepo.setStatus).toHaveBeenCalledWith(
      'user-9',
      UserStatus.SUSPENDED,
    );
    expect(sessionRepo.revokeAllForUser).toHaveBeenCalledWith(
      'user-9',
      'ADMIN',
      expect.any(Date),
    );
    expect(tokenStore.bumpTokenVersion).toHaveBeenCalledWith('user-9');
    expect(tokenStore.markSessionsRevoked).toHaveBeenCalledWith(
      ['sid-1', 'sid-2'],
      900,
    );
    expect(calls).toEqual([
      'write status',
      'close sessions',
      'bump version',
      'flag sessions',
    ]);
  });

  it('refuses an administrator, even when it is the caller themselves, and changes nothing (AC-5)', async () => {
    userRepo.findById.mockResolvedValue({ id: 'user-9', role: UserRole.ADMIN });

    expect(await code(suspend())).toBe('AUTH-021');

    expect(userRepo.setStatus).not.toHaveBeenCalled();
    expect(sessionRepo.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('answers USR-001 for a user that does not exist and changes nothing (AC-6)', async () => {
    userRepo.findById.mockResolvedValue(null);

    expect(await code(suspend())).toBe('USR-001');

    expect(userRepo.setStatus).not.toHaveBeenCalled();
  });

  it('runs all the steps again for an account that is already suspended, so an unfinished suspension can be completed (AC-6)', async () => {
    await suspend();
    await suspend();

    expect(sessionRepo.revokeAllForUser).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['bumping the token version', 'bumpTokenVersion'],
    ['flagging the sessions', 'markSessionsRevoked'],
  ] as const)(
    'answers 503 (not 500) when Redis fails while %s, after the suspension and the closed sessions are saved (AC-8)',
    async (_step, method) => {
      tokenStore[method].mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(suspend()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(userRepo.setStatus).toHaveBeenCalledWith(
        'user-9',
        UserStatus.SUSPENDED,
      );
      expect(sessionRepo.revokeAllForUser).toHaveBeenCalled();
    },
  );

  it('does not claim success in the log when Redis failed', async () => {
    tokenStore.bumpTokenVersion.mockRejectedValue(new Error('ECONNREFUSED'));

    await suspend().catch(() => undefined);

    expect(logs.join('\n')).not.toContain('suspended by');
  });

  it('logs who suspended whom and how many sessions were closed, ids only', async () => {
    await suspend();

    expect(logs.join('\n')).toContain(
      'User user-9 suspended by admin-1; 2 session(s) closed',
    );
  });

  it('does not close any session when writing the status failed', async () => {
    userRepo.setStatus.mockRejectedValue(new Error('db down'));

    await expect(suspend()).rejects.toThrow('db down');

    expect(sessionRepo.revokeAllForUser).not.toHaveBeenCalled();
  });
});

describe('ReinstateUserHandler', () => {
  let userRepo: { setStatus: ReturnType<typeof vi.fn> };
  const reinstate = () =>
    new ReinstateUserHandler(userRepo as unknown as IUserRepository).execute(
      new ReinstateUserCommand('user-9', 'admin-1'),
    );

  beforeEach(() => {
    userRepo = { setStatus: vi.fn().mockResolvedValue(true) };
  });

  it('sets the account back to ACTIVE (AC-3)', async () => {
    await reinstate();

    expect(userRepo.setStatus).toHaveBeenCalledWith(
      'user-9',
      UserStatus.ACTIVE,
    );
  });

  it('logs who reinstated whom', async () => {
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: any) => {
      logged.push(String(m));
    });

    await reinstate();

    expect(logged.join('\n')).toContain('User user-9 reinstated by admin-1');
  });

  it('answers USR-001 for a user that does not exist (AC-6)', async () => {
    userRepo.setStatus.mockResolvedValue(false);

    expect(await code(reinstate())).toBe('USR-001');
  });
});
