import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { TokenStore } from '../../infrastructure/token/token.store.js';
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

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { verifyAsync: ReturnType<typeof vi.fn> };
  let tokenStore: {
    isAccessTokenBlacklisted: ReturnType<typeof vi.fn>;
    getTokenVersion: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    jwtService = { verifyAsync: vi.fn() };
    tokenStore = {
      isAccessTokenBlacklisted: vi.fn(),
      getTokenVersion: vi.fn(),
    };
    guard = new JwtAuthGuard(
      jwtService as unknown as JwtService,
      tokenStore as unknown as TokenStore,
    );
  });

  it('throws UNAUTHORIZED_ACCESS when Authorization header is missing', async () => {
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      (e: DomainException) =>
        e instanceof DomainException &&
        e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );
  });

  it('throws UNAUTHORIZED_ACCESS when Authorization scheme is not Bearer', async () => {
    const ctx = makeContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      (e: DomainException) =>
        e instanceof DomainException &&
        e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );
  });

  it('throws TOKEN_REVOKED when token is blacklisted', async () => {
    const payload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      ver: 1,
      exp: 9999999999,
    };
    jwtService.verifyAsync.mockResolvedValue(payload);
    tokenStore.isAccessTokenBlacklisted.mockResolvedValue(true);

    const ctx = makeContext({ authorization: 'Bearer valid.token.here' });
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      (e: DomainException) =>
        e instanceof DomainException &&
        e.code === AuthErrorCodes.TOKEN_REVOKED.code,
    );
  });

  it('throws UNAUTHORIZED_ACCESS when token version is stale (logout-all)', async () => {
    const payload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      ver: 1,
      exp: 9999999999,
    };
    jwtService.verifyAsync.mockResolvedValue(payload);
    tokenStore.isAccessTokenBlacklisted.mockResolvedValue(false);
    tokenStore.getTokenVersion.mockResolvedValue(3); // currentVersion=3, payload.ver=1 → stale

    const ctx = makeContext({ authorization: 'Bearer valid.token.here' });
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      (e: DomainException) =>
        e instanceof DomainException &&
        e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );
  });

  it('attaches user, token and tokenExp to request when token is valid', async () => {
    const payload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      ver: 2,
      exp: 9999999999,
    };
    jwtService.verifyAsync.mockResolvedValue(payload);
    tokenStore.isAccessTokenBlacklisted.mockResolvedValue(false);
    tokenStore.getTokenVersion.mockResolvedValue(2); // same version → valid

    const req = {} as any;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext;
    Object.assign(req, {
      headers: { authorization: 'Bearer valid.token.here' },
    });

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.user).toEqual({ id: 'user-1', role: 'CUSTOMER', ver: 2 });
    expect(req.token).toBe('valid.token.here');
    expect(req.tokenExp).toBe(9999999999);
  });

  it('throws UNAUTHORIZED_ACCESS when jwt.verifyAsync throws (expired/invalid)', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    const ctx = makeContext({ authorization: 'Bearer expired.token' });
    await expect(guard.canActivate(ctx)).rejects.toSatisfy(
      (e: DomainException) =>
        e instanceof DomainException &&
        e.code === AuthErrorCodes.UNAUTHORIZED_ACCESS.code,
    );
  });

  it('verifies the signature with the JwtModule-configured secret (no secret passed in)', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'u',
      role: 'CUSTOMER',
      ver: 0,
      exp: 9999999999,
    });
    tokenStore.isAccessTokenBlacklisted.mockResolvedValue(false);
    tokenStore.getTokenVersion.mockResolvedValue(0);

    await guard.canActivate(
      makeContext({ authorization: 'Bearer some.jwt.token' }),
    );

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('some.jwt.token');
  });

  describe('Redis unavailable — fails closed instead of accepting a possibly-revoked token', () => {
    const validPayload = {
      sub: 'user-1',
      role: 'CUSTOMER',
      ver: 1,
      exp: 9999999999,
    };

    beforeEach(() => {
      jwtService.verifyAsync.mockResolvedValue(validPayload);
    });

    it('refuses with 503 when the blacklist lookup fails', async () => {
      tokenStore.isAccessTokenBlacklisted.mockRejectedValue(
        new Error('ECONNREFUSED'),
      );
      tokenStore.getTokenVersion.mockResolvedValue(1);

      const ctx = makeContext({ authorization: 'Bearer valid.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('refuses with 503 when the token-version lookup fails', async () => {
      tokenStore.isAccessTokenBlacklisted.mockResolvedValue(false);
      tokenStore.getTokenVersion.mockRejectedValue(new Error('ETIMEDOUT'));

      const ctx = makeContext({ authorization: 'Bearer valid.token.here' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('does not attach a user to the request when it refuses', async () => {
      tokenStore.isAccessTokenBlacklisted.mockRejectedValue(
        new Error('ECONNREFUSED'),
      );
      tokenStore.getTokenVersion.mockResolvedValue(1);
      const req = {
        headers: { authorization: 'Bearer valid.token.here' },
      } as any;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as ExecutionContext;

      await guard.canActivate(ctx).catch(() => undefined);

      expect(req.user).toBeUndefined();
    });
  });
});
