import { describe, it, expect, vi } from 'vitest';
import type { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { TokenIssuer } from './token-issuer.service.js';

describe('TokenIssuer', () => {
  const build = () => {
    const jwtService = { sign: vi.fn().mockReturnValue('signed.access.token') };
    const issuer = new TokenIssuer(jwtService as unknown as JwtService, {
      jwtSecret: 's'.repeat(32),
      accessTtlSeconds: 900,
      refreshTtlSeconds: 604800,
      sessionAbsoluteTtlSeconds: 2592000,
    });
    return { issuer, jwtService };
  };

  it('signs the access token with sub, role, the current token version and the session id', () => {
    const { issuer, jwtService } = build();

    const { accessToken } = issuer.issue(
      { id: 'u1', role: UserRole.ADMIN },
      4,
      'sid-1',
    );

    expect(accessToken).toBe('signed.access.token');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: 'u1',
      role: UserRole.ADMIN,
      ver: 4,
      sid: 'sid-1',
    });
  });

  it('issues an opaque 320-bit (40 bytes → 80 hex chars) refresh token, unique per call', () => {
    const { issuer } = build();
    const user = { id: 'u1', role: UserRole.CUSTOMER };

    const a = issuer.issue(user, 0, 'sid-1').refreshToken;
    const b = issuer.issue(user, 0, 'sid-1').refreshToken;

    expect(a).toMatch(/^[0-9a-f]{80}$/);
    expect(a).not.toBe(b);
  });

  it('exposes the access and refresh TTLs from config', () => {
    const { issuer } = build();
    expect(issuer.refreshTtlSeconds).toBe(604800);
    expect(issuer.sessionAbsoluteTtlSeconds).toBe(2592000);
    expect(issuer.accessTtlSeconds).toBe(900);
  });
});
