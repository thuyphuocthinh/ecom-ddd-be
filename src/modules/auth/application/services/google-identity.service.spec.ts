import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { GoogleIdentityService } from './google-identity.service.js';
import { AuthErrorCodes } from '@/core/index.js';
import { AuthDomainException } from '../../domain/index.js';
import type {
  GoogleIdentity,
  IGoogleTokenVerifier,
} from '../../domain/index.js';
import type { GoogleTokenStore } from '../../infrastructure/index.js';

const IDENTITY: GoogleIdentity = {
  sub: 'google-sub-1',
  email: 'jane@example.com',
  emailVerified: true,
  name: 'Jane',
  expiresAt: new Date(Date.now() + 3600_000),
  tokenId: 'signed-content-id',
};

describe('GoogleIdentityService', () => {
  let service: GoogleIdentityService;
  let calls: string[];
  let verifier: { verify: ReturnType<typeof vi.fn> };
  let usedTokens: {
    claim: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

  const build = (clientIds = ['web.apps.googleusercontent.com']) =>
    new GoogleIdentityService(
      { clientIds },
      verifier as unknown as IGoogleTokenVerifier,
      usedTokens as unknown as GoogleTokenStore,
    );

  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (e: any) => e.code ?? e.constructor.name,
    );

  beforeEach(() => {
    calls = [];
    verifier = {
      verify: vi.fn().mockImplementation(async () => {
        calls.push('verify token');
        return IDENTITY;
      }),
    };
    usedTokens = {
      claim: vi.fn().mockImplementation(async () => {
        calls.push('claim token');
        return true;
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    service = build();
  });

  it('returns who the token is about once every check has passed', async () => {
    await expect(service.authenticate('tok')).resolves.toEqual(IDENTITY);
  });

  it('checks the token itself first, and only marks it used after the other checks (AC-5, AC-6)', async () => {
    await service.authenticate('tok');

    expect(calls).toEqual(['verify token', 'claim token']);
    // marked by what Google signed, not by the text the token arrived as (A1)
    expect(usedTokens.claim).toHaveBeenCalledWith(
      'signed-content-id',
      IDENTITY.expiresAt,
    );
  });

  it('answers 503 and does nothing else when sign in with Google is not switched on (AC-13)', async () => {
    service = build([]);

    expect(await code(service.authenticate('tok'))).toBe(
      AuthErrorCodes.GOOGLE_NOT_CONFIGURED.code,
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('refuses a token the verifier refuses, without marking anything used (AC-5)', async () => {
    verifier.verify.mockRejectedValue(
      new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN),
    );

    expect(await code(service.authenticate('tok'))).toBe('AUTH-014');
    expect(usedTokens.claim).not.toHaveBeenCalled();
  });

  it('lets a 503 from the verifier through unchanged (AC-14)', async () => {
    verifier.verify.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.authenticate('tok')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('the nonce (AC-7)', () => {
    it('accepts a matching nonce', async () => {
      verifier.verify.mockResolvedValue({ ...IDENTITY, nonce: 'n-1' });

      await expect(service.authenticate('tok', 'n-1')).resolves.toBeDefined();
    });

    it.each([
      ['the request sends none', undefined],
      ['the request sends a different one', 'other'],
    ])('refuses a token that carries a nonce when %s', async (_why, sent) => {
      verifier.verify.mockResolvedValue({ ...IDENTITY, nonce: 'n-1' });

      expect(await code(service.authenticate('tok', sent))).toBe('AUTH-014');
      expect(usedTokens.claim).not.toHaveBeenCalled();
    });

    it('refuses a request that sends a nonce for a token that has none: the token did not come from that sign-in', async () => {
      expect(await code(service.authenticate('tok', 'sent-anyway'))).toBe(
        'AUTH-014',
      );
      expect(usedTokens.claim).not.toHaveBeenCalled();
    });

    it('needs no nonce at all when neither side has one (an empty string counts as none)', async () => {
      await expect(service.authenticate('tok')).resolves.toBeDefined();
      await expect(service.authenticate('tok', '')).resolves.toBeDefined();
    });
  });

  it('refuses a verified-by-nobody email with 403 and does not use the token up (AC-4)', async () => {
    verifier.verify.mockResolvedValue({ ...IDENTITY, emailVerified: false });

    expect(await code(service.authenticate('tok'))).toBe('AUTH-015');
    expect(usedTokens.claim).not.toHaveBeenCalled();
  });

  it('refuses a token that was used before (AC-6)', async () => {
    usedTokens.claim.mockResolvedValue(false);

    expect(await code(service.authenticate('tok'))).toBe('AUTH-014');
  });

  it('gives a token back by its signed id', async () => {
    await service.release(IDENTITY);

    expect(usedTokens.release).toHaveBeenCalledWith('signed-content-id');
  });

  it('answers 503 when Redis fails, instead of skipping the used-before check (AC-14)', async () => {
    usedTokens.claim.mockRejectedValue(new ServiceUnavailableException());

    await expect(service.authenticate('tok')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
