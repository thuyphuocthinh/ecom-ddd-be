import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { TokenStore } from '../../infrastructure/redis/token/token.store.js';
import { DomainException, AuthErrorCodes } from '../../index.js';

const makeContext = (
  headers: Record<string, string> = {},
  request: Record<string, unknown> = {},
) => {
  const req = { headers, ...request } as any;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as ExecutionContext;
};

const isCode = (code: string) => (e: DomainException) =>
  e instanceof DomainException && e.code === code;

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { verifyAsync: ReturnType<typeof vi.fn> };
  let tokenStore: {
    isSessionRevoked: ReturnType<typeof vi.fn>;
    getTokenVersion: ReturnType<typeof vi.fn>;
  };

  const payload = {
    sub: 'user-1',
    role: 'CUSTOMER',
    ver: 2,
    sid: 'sid-1',
    exp: 9999999999,
  };
  const bearer = { authorization: 'Bearer valid.token.here' };

  beforeEach(() => {
    jwtService = { verifyAsync: vi.fn().mockResolvedValue(payload) };
    tokenStore = {
      isSessionRevoked: vi.fn().mockResolvedValue(false),
      getTokenVersion: vi.fn().mockResolvedValue(2),
    };
    guard = new JwtAuthGuard(
      jwtService as unknown as JwtService,
      tokenStore as unknown as TokenStore,
    );
  });

  it('throws UNAUTHORIZED_ACCESS when Authorization header is missing', async () => {
    await expect(guard.canActivate(makeContext({}))).rejects.toSatisfy(
      isCode(AuthErrorCodes.UNAUTHORIZED_ACCESS.code),
    );
  });

  it('throws UNAUTHORIZED_ACCESS when Authorization scheme is not Bearer', async () => {
    const ctx = makeContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      isCode(AuthErrorCodes.UNAUTHORIZED_ACCESS.code),
    );
  });

  it('throws UNAUTHORIZED_ACCESS when jwt.verifyAsync throws (expired/invalid)', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer expired.token' })),
    ).rejects.toSatisfy(isCode(AuthErrorCodes.UNAUTHORIZED_ACCESS.code));
  });

  it('verifies the signature with the JwtModule-configured secret (no secret passed in)', async () => {
    await guard.canActivate(
      makeContext({ authorization: 'Bearer some.jwt.token' }),
    );

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('some.jwt.token');
  });

  it('rejects a token without a session id (issued before sessions existed) and checks nothing else', async () => {
    jwtService.verifyAsync.mockResolvedValue({ ...payload, sid: undefined });

    await expect(guard.canActivate(makeContext(bearer))).rejects.toSatisfy(
      isCode(AuthErrorCodes.UNAUTHORIZED_ACCESS.code),
    );
    expect(tokenStore.isSessionRevoked).not.toHaveBeenCalled();
  });

  it("throws TOKEN_REVOKED when the token's session is flagged revoked", async () => {
    tokenStore.isSessionRevoked.mockResolvedValue(true);

    await expect(guard.canActivate(makeContext(bearer))).rejects.toSatisfy(
      isCode(AuthErrorCodes.TOKEN_REVOKED.code),
    );
    expect(tokenStore.isSessionRevoked).toHaveBeenCalledWith('sid-1');
  });

  it('throws UNAUTHORIZED_ACCESS when token version is stale (logout-all)', async () => {
    tokenStore.getTokenVersion.mockResolvedValue(3); // current 3, payload.ver 2 → stale

    await expect(guard.canActivate(makeContext(bearer))).rejects.toSatisfy(
      isCode(AuthErrorCodes.UNAUTHORIZED_ACCESS.code),
    );
  });

  it('attaches user (with the session id) to the request when the token is valid', async () => {
    const req = { headers: bearer } as any;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(req.user).toEqual({
      id: 'user-1',
      role: 'CUSTOMER',
      ver: 2,
      sid: 'sid-1',
    });
  });

  describe('Redis unavailable — fails closed instead of accepting a possibly-revoked token', () => {
    it('refuses with 503 when the session-revoked lookup fails', async () => {
      tokenStore.isSessionRevoked.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        guard.canActivate(makeContext(bearer)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('refuses with 503 when the token-version lookup fails', async () => {
      tokenStore.getTokenVersion.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(
        guard.canActivate(makeContext(bearer)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('does not attach a user to the request when it refuses', async () => {
      tokenStore.isSessionRevoked.mockRejectedValue(new Error('ECONNREFUSED'));
      const req = { headers: bearer } as any;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as ExecutionContext;

      await guard.canActivate(ctx).catch(() => undefined);

      expect(req.user).toBeUndefined();
    });
  });
});
