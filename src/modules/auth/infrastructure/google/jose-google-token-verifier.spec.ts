import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  type KeyObject,
} from 'jose';
import { JoseGoogleTokenVerifier } from './jose-google-token-verifier.js';
import { AuthErrorCodes } from '@/core/index.js';

const CLIENT_ID = 'web-123.apps.googleusercontent.com';
const OTHER_CLIENT_ID = 'android-456.apps.googleusercontent.com';

/**
 * No test calls Google: tokens are signed with a key pair made here, and the verifier is given
 * the matching public key as its key set.
 */
describe('JoseGoogleTokenVerifier', () => {
  let privateKey: KeyObject | CryptoKey;
  let keys: JWTVerifyGetKey;
  let verifier: JoseGoogleTokenVerifier;
  let strangerKey: KeyObject | CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk: JWK = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'k1',
      alg: 'RS256',
    };
    keys = createLocalJWKSet({ keys: [jwk] });
    verifier = new JoseGoogleTokenVerifier([CLIENT_ID, OTHER_CLIENT_ID], keys);
    strangerKey = (await generateKeyPair('RS256')).privateKey;
  });
  afterEach(() => vi.restoreAllMocks());

  const claims = (over: Record<string, unknown> = {}) => ({
    sub: 'google-sub-1',
    email: 'Jane.Doe@Example.com',
    email_verified: true,
    name: 'Jane Doe',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    ...over,
  });

  /** Signs like Google would, with sensible defaults a test can override */
  const sign = async (
    over: Record<string, unknown> = {},
    options: {
      key?: KeyObject | CryptoKey;
      issuer?: string;
      audience?: string;
      issuedAt?: number | Date;
      expiresIn?: string;
      alg?: string;
    } = {},
  ) =>
    new SignJWT(claims(over))
      .setProtectedHeader({ alg: options.alg ?? 'RS256', kid: 'k1' })
      .setIssuer(options.issuer ?? 'https://accounts.google.com')
      .setAudience(options.audience ?? CLIENT_ID)
      .setIssuedAt(options.issuedAt)
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(options.key ?? privateKey);

  const invalid = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy(
      (e: any) => e.code === AuthErrorCodes.INVALID_GOOGLE_TOKEN.code,
    );

  describe('a good token', () => {
    it('gives back who it is about, with the email lower-cased (AC-1)', async () => {
      const identity = await verifier.verify(await sign({ nonce: 'abc' }));

      expect(identity).toMatchObject({
        sub: 'google-sub-1',
        email: 'jane.doe@example.com',
        emailVerified: true,
        name: 'Jane Doe',
        picture: 'https://lh3.googleusercontent.com/a/photo',
        nonce: 'abc',
      });
      expect(identity.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('accepts both Google issuer spellings', async () => {
      await expect(
        verifier.verify(await sign({}, { issuer: 'accounts.google.com' })),
      ).resolves.toMatchObject({ sub: 'google-sub-1' });
    });

    it('accepts a token made for any of the configured client ids (web, Android...)', async () => {
      await expect(
        verifier.verify(await sign({}, { audience: OTHER_CLIENT_ID })),
      ).resolves.toMatchObject({ sub: 'google-sub-1' });
    });

    it('reads email_verified as true when Google sends the string "true"', async () => {
      const identity = await verifier.verify(
        await sign({ email_verified: 'true' }),
      );

      expect(identity.emailVerified).toBe(true);
    });

    it('reports an email that is not verified as such, leaving the decision to the caller (AC-4)', async () => {
      const unverified = await verifier.verify(
        await sign({ email_verified: false }),
      );
      const missing = await verifier.verify(
        await sign({ email_verified: undefined }),
      );

      expect(unverified.emailVerified).toBe(false);
      expect(missing.emailVerified).toBe(false);
    });

    it('does not insist on name and picture', async () => {
      const identity = await verifier.verify(
        await sign({ name: undefined, picture: undefined }),
      );

      expect(identity.name).toBeUndefined();
      expect(identity.picture).toBeUndefined();
    });
  });

  describe('a token that must be refused (AC-5)', () => {
    it('signed with a key Google does not publish', async () => {
      await invalid(verifier.verify(await sign({}, { key: strangerKey })));
    });

    it('issued by somebody else', async () => {
      await invalid(
        verifier.verify(await sign({}, { issuer: 'https://evil.example.com' })),
      );
    });

    it('made for another application (wrong audience)', async () => {
      await invalid(
        verifier.verify(
          await sign(
            {},
            { audience: 'someone-else.apps.googleusercontent.com' },
          ),
        ),
      );
    });

    it('that has expired', async () => {
      const now = Math.floor(Date.now() / 1000);
      await invalid(
        verifier.verify(
          await sign({}, { issuedAt: now - 7200, expiresIn: '-1h' }),
        ),
      );
    });

    it('issued 11 minutes ago: the limit is about 10 minutes (9 plus the clock tolerance), not more', async () => {
      const now = Math.floor(Date.now() / 1000);
      await invalid(
        verifier.verify(await sign({}, { issuedAt: now - 11 * 60 })),
      );
    });

    it('still accepts one issued 8 minutes ago', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(
        verifier.verify(await sign({}, { issuedAt: now - 8 * 60 })),
      ).resolves.toMatchObject({ sub: 'google-sub-1' });
    });

    it('issued in the future beyond the clock tolerance', async () => {
      const now = Math.floor(Date.now() / 1000);
      await invalid(
        verifier.verify(
          await sign({}, { issuedAt: now + 10 * 60, expiresIn: '2h' }),
        ),
      );
    });

    it('without an issue time (iat): the age cannot be checked', async () => {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setExpirationTime('1h')
        .sign(privateKey);

      await invalid(verifier.verify(token));
    });

    it('without an expiry time (exp)', async () => {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .sign(privateKey);

      await invalid(verifier.verify(token));
    });

    it('issued more than 10 minutes ago, though still valid: only fresh tokens are accepted', async () => {
      const now = Math.floor(Date.now() / 1000);
      await invalid(
        verifier.verify(await sign({}, { issuedAt: now - 15 * 60 })),
      );
    });

    it('without a subject', async () => {
      await invalid(verifier.verify(await sign({ sub: undefined })));
    });

    it('without an email', async () => {
      await invalid(verifier.verify(await sign({ email: undefined })));
    });

    it('that is not a JWT at all', async () => {
      await invalid(verifier.verify('not-a-token'));
      await invalid(verifier.verify(''));
      await invalid(verifier.verify('a.b.c'));
    });

    it('with the "none" algorithm, which means no signature', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({
          ...claims(),
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      await invalid(verifier.verify(`${header}.${payload}.`));
    });

    it('signed with a shared secret (HS256) instead of the RSA key: the classic algorithm-confusion attack', async () => {
      const forged = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(
          new TextEncoder().encode('some-shared-secret-of-sufficient-length'),
        );

      await invalid(verifier.verify(forged));
    });

    it('whose payload was altered after signing', async () => {
      const token = await sign();
      const [header, payload, signature] = token.split('.');
      const altered = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
          email: 'victim@example.com',
        }),
      ).toString('base64url');

      await invalid(verifier.verify(`${header}.${altered}.${signature}`));
    });
  });

  describe('refusing everything when no client id is configured (fail closed)', () => {
    it('accepts no token at all with an empty list of client ids', async () => {
      const none = new JoseGoogleTokenVerifier([], keys);

      await invalid(none.verify(await sign()));
    });
  });

  describe('the token id', () => {
    it('is the same for the same signed token however it is written, and different for a different token', async () => {
      const token = await sign();
      const first = await verifier.verify(token);
      const again = await verifier.verify(token);
      const other = await verifier.verify(
        await sign({}, { issuedAt: Math.floor(Date.now() / 1000) - 5 }),
      );

      expect(first.tokenId).toBe(again.tokenId);
      expect(first.tokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(other.tokenId).not.toBe(first.tokenId);
    });

    it('does not change when the signature is written with unused bits changed or with whitespace added: those variants still verify, so the id must not depend on them', async () => {
      const token = await sign();
      const [header, payload, signature] = token.split('.');
      // the last base64url character only carries padding bits for an RSA signature of this size
      const last = signature.slice(-1);
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const variants = [
        `${token} `,
        `${token}\n`,
        `${header}.${payload}.${signature.slice(0, -1)}${alphabet[(alphabet.indexOf(last) + 1) % 64]}`,
      ];
      const original = await verifier.verify(token);

      for (const variant of variants) {
        // a variant either verifies (then it must carry the same id) or is refused outright
        const result = await verifier.verify(variant).then(
          (identity) => identity.tokenId,
          () => 'refused',
        );
        expect([original.tokenId, 'refused']).toContain(result);
      }
    });
  });

  describe('what is logged when the client id does not match', () => {
    it('names the claim that did not match, never the token or any value', async () => {
      const warnings: string[] = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
        warnings.push(String(m));
      });
      const token = await sign(
        {},
        { audience: 'someone-else.apps.googleusercontent.com' },
      );

      await verifier.verify(token).catch(() => undefined);

      expect(warnings.join('\n')).toContain('"aud" claim did not match');
      expect(warnings.join('\n')).not.toContain('someone-else');
      expect(warnings.join('\n')).not.toContain(token.slice(0, 20));
    });
  });

  describe('when Google cannot be reached (AC-14)', () => {
    it('answers 503, not "invalid token": an outage is not the caller fault', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const unreachable: JWTVerifyGetKey = async () => {
        throw new TypeError('fetch failed');
      };
      const failing = new JoseGoogleTokenVerifier([CLIENT_ID], unreachable);

      await expect(failing.verify(await sign())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('logs only the kind of error, never the token', async () => {
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
        logged.push(String(m));
      });
      const unreachable: JWTVerifyGetKey = async () => {
        throw new TypeError('fetch failed');
      };
      const token = await sign();

      await new JoseGoogleTokenVerifier([CLIENT_ID], unreachable)
        .verify(token)
        .catch(() => undefined);

      expect(logged.join('\n')).not.toContain(token.slice(0, 20));
      expect(logged.join('\n')).not.toContain('jane');
    });
  });
});
