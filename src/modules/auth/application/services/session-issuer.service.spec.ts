import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionIssuer } from './session-issuer.service.js';
import type { ISessionRepository } from '../../domain/index.js';
import { HashUtil } from '@/core/index.js';
import type { TokenStore } from '../../infrastructure/index.js';
import type { TokenIssuer } from './token-issuer.service.js';

const CLIENT = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Chrome/128.0' };
const USER = { id: 'user-123', role: 'CUSTOMER' } as const;

describe('SessionIssuer', () => {
  let issuer: SessionIssuer;
  let sessionRepo: { save: ReturnType<typeof vi.fn> };
  let tokenStore: { getTokenVersion: ReturnType<typeof vi.fn> };
  let tokenIssuer: {
    issue: ReturnType<typeof vi.fn>;
    refreshTtlSeconds: number;
    sessionAbsoluteTtlSeconds: number;
  };

  beforeEach(() => {
    sessionRepo = { save: vi.fn().mockResolvedValue(undefined) };
    tokenStore = { getTokenVersion: vi.fn().mockResolvedValue(7) };
    tokenIssuer = {
      issue: vi.fn().mockReturnValue({
        accessToken: 'signed.access.token',
        refreshToken: 'opaque-rt',
      }),
      refreshTtlSeconds: 604800,
      sessionAbsoluteTtlSeconds: 2592000,
    };
    issuer = new SessionIssuer(
      sessionRepo as unknown as ISessionRepository,
      tokenStore as unknown as TokenStore,
      tokenIssuer as unknown as TokenIssuer,
    );
  });

  it('returns the issued token pair', async () => {
    await expect(issuer.start(USER, CLIENT)).resolves.toEqual({
      accessToken: 'signed.access.token',
      refreshToken: 'opaque-rt',
    });
  });

  it('issues the access token for the current token version and the new session id', async () => {
    await issuer.start(USER, CLIENT);

    expect(tokenIssuer.issue).toHaveBeenCalledWith(
      USER,
      7,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
  });

  it('stores a session carrying the device, IP and only the hash of the refresh token', async () => {
    await issuer.start(USER, CLIENT);

    const sessionId = tokenIssuer.issue.mock.calls[0][2];
    expect(sessionRepo.save).toHaveBeenCalledOnce();
    const session = sessionRepo.save.mock.calls[0][0];
    expect(session).toMatchObject({
      id: sessionId, // the sid inside the access token is this session
      userId: 'user-123',
      refreshTokenHash: HashUtil.sha256('opaque-rt'),
      deviceName: CLIENT.userAgent,
      ipAddress: CLIENT.ip,
      revokedAt: null,
    });
    expect(JSON.stringify(session)).not.toContain('opaque-rt');
  });

  it('does not fail on a client with no User-Agent', async () => {
    await issuer.start(USER, { ip: '203.0.113.7', userAgent: '' });

    expect(sessionRepo.save.mock.calls[0][0].deviceName).toBe('Unknown device');
  });

  it('starts the session with the configured sliding and absolute lifetimes', async () => {
    await issuer.start(USER, CLIENT);

    const session = sessionRepo.save.mock.calls[0][0];
    expect(
      (session.expiresAt.getTime() - session.createdAt.getTime()) / 1000,
    ).toBe(604800);

    // a shorter absolute lifetime wins over the sliding one
    sessionRepo.save.mockClear();
    tokenIssuer.sessionAbsoluteTtlSeconds = 3600;
    await issuer.start(USER, CLIENT);
    const capped = sessionRepo.save.mock.calls[0][0];
    expect(
      (capped.expiresAt.getTime() - capped.createdAt.getTime()) / 1000,
    ).toBe(3600);
  });

  it('does not hand out tokens when the session cannot be stored', async () => {
    sessionRepo.save.mockRejectedValue(new Error('db down'));

    await expect(issuer.start(USER, CLIENT)).rejects.toThrow('db down');
  });
});
