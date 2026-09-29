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
    });
    return { issuer, jwtService };
  };

  it('signs the access token with sub, role and the current token version', () => {
    const { issuer, jwtService } = build();

    const { accessToken } = issuer.issue({ id: 'u1', role: UserRole.ADMIN }, 4);

    expect(accessToken).toBe('signed.access.token');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: 'u1',
      role: UserRole.ADMIN,
      ver: 4,
    });
  });

  it('issues an opaque 320-bit (40 bytes → 80 hex chars) refresh token, unique per call', () => {
    const { issuer } = build();

    const a = issuer.issue(
      { id: 'u1', role: UserRole.CUSTOMER },
      0,
    ).refreshToken;
    const b = issuer.issue(
      { id: 'u1', role: UserRole.CUSTOMER },
      0,
    ).refreshToken;

    expect(a).toMatch(/^[0-9a-f]{80}$/);
    expect(a).not.toBe(b);
  });

  it('exposes the refresh TTL from config', () => {
    expect(build().issuer.refreshTtlSeconds).toBe(604800);
  });
});
