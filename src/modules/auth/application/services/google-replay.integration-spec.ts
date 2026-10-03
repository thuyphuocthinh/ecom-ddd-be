import { Test, TestingModule } from '@nestjs/testing';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyObject,
} from 'jose';
import { GoogleIdentityService } from './google-identity.service.js';
import { JoseGoogleTokenVerifier } from '../../infrastructure/google/jose-google-token-verifier.js';
import { GoogleTokenStore } from '../../infrastructure/redis/google-token.store.js';
import { googleConfig } from '../../google.config.js';
import { GOOGLE_TOKEN_VERIFIER } from '../../domain/index.js';
import { RedisService } from '@/core/index.js';

const CLIENT_ID = 'replay-test.apps.googleusercontent.com';

/**
 * The real verifier (with a key pair made here), the real service and the real Redis together.
 * The point: a token that was used must stay used however it is written. `jose` accepts the same
 * signed token written with extra whitespace or with unused signature bits changed, so a mark
 * keyed by the text of the token could be dodged by changing one character.
 */
describe('Google token replay (Integration)', () => {
  let service: GoogleIdentityService;
  let redis: RedisService;
  let privateKey: KeyObject | CryptoKey;

  const sign = (issuedAtOffsetSeconds = 0) =>
    new SignJWT({
      sub: 'replay-sub',
      email: 'replay@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setIssuedAt(Math.floor(Date.now() / 1000) + issuedAtOffsetSeconds)
      .setExpirationTime('1h')
      .sign(privateKey);

  const refused = (promise: Promise<unknown>) =>
    expect(promise).rejects.toSatisfy((e: any) => e.code === 'AUTH-014');

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk: JWK = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'k1',
      alg: 'RS256',
    };
    const verifier = new JoseGoogleTokenVerifier(
      [CLIENT_ID],
      createLocalJWKSet({ keys: [jwk] }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleIdentityService,
        GoogleTokenStore,
        RedisService,
        { provide: googleConfig.KEY, useValue: { clientIds: [CLIENT_ID] } },
        { provide: GOOGLE_TOKEN_VERIFIER, useValue: verifier },
      ],
    }).compile();
    service = module.get(GoogleIdentityService);
    redis = module.get(RedisService);
  });

  beforeEach(async () => {
    const keys = await redis.getClient().keys('*google_token*');
    if (keys.length > 0) await redis.getClient().del(...keys);
  });

  afterAll(async () => {
    await redis.getClient().quit();
  });

  it('accepts a token once and refuses the very same text the second time (AC-6)', async () => {
    const token = await sign();

    await expect(service.authenticate(token)).resolves.toMatchObject({
      sub: 'replay-sub',
    });
    await refused(service.authenticate(token));
  });

  it('refuses a used token written with whitespace added', async () => {
    const token = await sign();
    await service.authenticate(token);

    await refused(service.authenticate(`${token} `));
    await refused(service.authenticate(`${token}\n`));
    await refused(service.authenticate(` ${token}`));
  });

  it('refuses a used token whose signature was rewritten in the bits that carry no information', async () => {
    const token = await sign();
    await service.authenticate(token);
    const [header, payload, signature] = token.split('.');
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = signature.slice(-1);

    for (let step = 1; step < 4; step++) {
      const changed = alphabet[(alphabet.indexOf(last) + step) % 64];
      const variant = `${header}.${payload}.${signature.slice(0, -1)}${changed}`;
      // whether the library accepts this spelling or not, it must never log anybody in again
      await refused(service.authenticate(variant));
    }
  });

  it('still accepts a genuinely different token for the same person', async () => {
    await service.authenticate(await sign());

    await expect(service.authenticate(await sign(-5))).resolves.toMatchObject({
      sub: 'replay-sub',
    });
  });

  it('lets a token be used again once it was given back after a failure', async () => {
    const token = await sign();
    const identity = await service.authenticate(token);
    await service.release(identity);

    await expect(service.authenticate(token)).resolves.toMatchObject({
      sub: 'replay-sub',
    });
  });
});
