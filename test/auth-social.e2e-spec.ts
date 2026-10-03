import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  EMAIL_SENDER,
  AuthErrorCodes,
} from './../src/core/index.js';
import type { EmailMessage } from './../src/core/index.js';
import {
  AuthDomainException,
  GOOGLE_TOKEN_VERIFIER,
  type GoogleIdentity,
} from './../src/modules/auth/domain/index.js';

const API = '/api/v1';
const PASSWORD = 'Sunny-Giraffe-42!';
const CLIENT_ID = 'e2e-web.apps.googleusercontent.com';

const mailbox = {
  sent: [] as EmailMessage[],
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  },
};

/** What the fake Google verifier is told to do with the next token */
interface FakeToken {
  sub: string;
  email: string;
  verified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
  broken?: boolean;
  unreachable?: boolean;
  /** Makes every token string different, because each token can be used only once */
  n?: string;
}

/**
 * Stands in for Google: a "token" is just JSON saying what the real one would have proven. The
 * rest (used once, nonce, email verified, account rules) is the real code.
 */
const fakeVerifier = {
  async verify(idToken: string): Promise<GoogleIdentity> {
    let t: FakeToken;
    try {
      t = JSON.parse(idToken) as FakeToken;
    } catch {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
    if (t.broken) {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
    if (t.unreachable) {
      throw new ServiceUnavailableException(
        'Google sign-in is temporarily unavailable',
      );
    }
    return {
      sub: t.sub,
      email: t.email.trim().toLowerCase(),
      emailVerified: t.verified ?? true,
      name: t.name,
      picture: t.picture,
      nonce: t.nonce,
      expiresAt: new Date(Date.now() + 3600_000),
      // identifies the token like the real verifier does: by its signed content, not its text
      tokenId: `${t.sub}:${t.n}`,
    };
  },
};

/** A token string; every call gives a different one so it is a new token each time */
const tok = (t: FakeToken): string => JSON.stringify({ ...t, n: randomUUID() });

describe('Auth social (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const original = { ...process.env };

  const http = () => request(app.getHttpServer());
  const google = (token: string, nonce?: string) =>
    http().post(`${API}/auth/google`).send({ idToken: token, nonce });
  const link = (
    accessToken: string,
    token: string,
    currentPassword: string | null = PASSWORD,
  ) =>
    http()
      .post(`${API}/auth/google/link`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ idToken: token, currentPassword: currentPassword ?? undefined });
  const unlink = (accessToken: string) =>
    http()
      .delete(`${API}/auth/google`)
      .set('Authorization', `Bearer ${accessToken}`);
  const me = (accessToken: string) =>
    http().get(`${API}/users/me`).set('Authorization', `Bearer ${accessToken}`);

  const buildApp = async (): Promise<INestApplication> => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .overrideProvider(GOOGLE_TOKEN_VERIFIER)
      .useValue(fakeVerifier)
      .compile();
    const instance = module.createNestApplication();
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    instance.useGlobalFilters(
      new AllExceptionsFilter(instance.get(ClsService)),
    );
    instance.useGlobalInterceptors(new ResponseInterceptor());
    instance.setGlobalPrefix(API.replace('/', ''));
    await instance.init();
    return instance;
  };

  /** A person who registered with an email and password */
  const registerWithPassword = async (email: string, displayName?: string) => {
    await http()
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD, displayName })
      .expect(202);
    const code = [...mailbox.sent]
      .reverse()
      .find((m) => m.to === email)!
      .text.match(/\b(\d{6})\b/)![1];
    const res = await http()
      .post(`${API}/auth/verify-email`)
      .send({ email, code, password: PASSWORD })
      .expect(200);
    mailbox.sent.length = 0;
    return res.body.data as { accessToken: string; refreshToken: string };
  };

  const credentialsOf = async (email: string) => {
    const user = await prisma.user.findFirst({
      where: {
        credentials: { some: { provider: 'EMAIL', identifier: email } },
      },
      include: { credentials: true },
    });
    return user;
  };

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_IDS = CLIENT_ID;
    app = await buildApp();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...original };
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redis.getClient().flushdb();
    mailbox.sent.length = 0;
  });

  describe('AC-1: a new person signs up with Google', () => {
    it('creates an account with a Google credential and an email credential that has no password, and logs in', async () => {
      const res = await google(
        tok({
          sub: 'g-1',
          email: 'Jane@Example.com',
          name: 'Jane Doe',
          picture: 'https://lh3.googleusercontent.com/a/p',
        }),
      ).expect(200);

      expect(res.body.data.isNewUser).toBe(true);
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
      const user = await credentialsOf('jane@example.com');
      expect(user!.role).toBe('CUSTOMER');
      expect(user!.displayName).toBe('Jane Doe');
      expect(user!.avatarUrl).toBe('https://lh3.googleusercontent.com/a/p');
      const byProvider = Object.fromEntries(
        user!.credentials.map((c) => [c.provider, c]),
      );
      expect(byProvider.GOOGLE.identifier).toBe('g-1');
      expect(byProvider.GOOGLE.secret).toBeNull();
      expect(byProvider.EMAIL.identifier).toBe('jane@example.com');
      expect(byProvider.EMAIL.secret).toBeNull();
      // a real session, like any other login
      expect(await prisma.session.count({ where: { userId: user!.id } })).toBe(
        1,
      );
      await me(res.body.data.accessToken).expect(200);
    });
  });

  describe('AC-2: signing in again', () => {
    it('goes to the same account, even if the email in the token changed, and never overwrites the name the user edited', async () => {
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com', name: 'Jane Doe' }),
      ).expect(200);
      await prisma.user.updateMany({ data: { displayName: 'My edited name' } });

      const again = await google(
        tok({ sub: 'g-1', email: 'jane.new@example.com', name: 'Google Name' }),
      ).expect(200);

      expect(again.body.data.isNewUser).toBe(false);
      expect(await prisma.user.count()).toBe(1);
      const user = await prisma.user.findFirst();
      expect(user!.displayName).toBe('My edited name');
    });
  });

  describe('AC-3: an email that already has an account', () => {
    it('links Google to the existing account, logs in to it, keeps the password working, and tells the owner', async () => {
      await registerWithPassword('jane@example.com');

      const res = await google(
        tok({ sub: 'g-1', email: 'jane@example.com', name: 'Jane Doe' }),
      ).expect(200);

      expect(res.body.data.isNewUser).toBe(false);
      expect(await prisma.user.count()).toBe(1);
      const user = await credentialsOf('jane@example.com');
      expect(user!.credentials.map((c) => c.provider).sort()).toEqual([
        'EMAIL',
        'GOOGLE',
      ]);
      // the password credential still holds its password
      expect(
        user!.credentials.find((c) => c.provider === 'EMAIL')!.secret,
      ).not.toBeNull();
      await http()
        .post(`${API}/auth/login`)
        .send({ email: 'jane@example.com', password: PASSWORD })
        .expect(200);
      const notice = mailbox.sent.find((m) => m.to === 'jane@example.com');
      expect(notice!.subject).toContain('Google');
    });

    it('fills the display name from Google when the account had none, but keeps an existing one', async () => {
      await registerWithPassword('empty@example.com');
      await registerWithPassword('named@example.com', 'Chosen Name');

      await google(
        tok({ sub: 'g-1', email: 'empty@example.com', name: 'Google One' }),
      ).expect(200);
      await google(
        tok({ sub: 'g-2', email: 'named@example.com', name: 'Google Two' }),
      ).expect(200);

      expect((await credentialsOf('empty@example.com'))!.displayName).toBe(
        'Google One',
      );
      expect((await credentialsOf('named@example.com'))!.displayName).toBe(
        'Chosen Name',
      );
    });
  });

  describe('AC-4: an email Google has not verified', () => {
    it('is refused with 403 and links or creates nothing, even when the email matches an account', async () => {
      await registerWithPassword('jane@example.com');

      const res = await google(
        tok({ sub: 'g-1', email: 'jane@example.com', verified: false }),
      ).expect(403);

      expect(res.body.code).toBe('AUTH-015');
      const user = await credentialsOf('jane@example.com');
      expect(user!.credentials.map((c) => c.provider)).toEqual(['EMAIL']);
      await google(
        tok({ sub: 'g-2', email: 'nobody@example.com', verified: false }),
      ).expect(403);
      expect(await prisma.user.count()).toBe(1);
    });
  });

  describe('AC-5: a token that is not acceptable', () => {
    it('answers 401 AUTH-014 with the same message for every kind of bad token, and creates nothing', async () => {
      const bad = [
        tok({ sub: 'g-1', email: 'a@example.com', broken: true }),
        'not json at all',
        '',
      ];
      const messages = new Set<string>();

      for (const idToken of bad) {
        const res = await http()
          .post(`${API}/auth/google`)
          .send({ idToken: idToken || 'x' })
          .expect(401);
        expect(res.body.code).toBe('AUTH-014');
        messages.add(res.body.message);
      }

      expect(messages.size).toBe(1);
      expect(await prisma.user.count()).toBe(0);
    });

    it('rejects a body with no idToken, a token that is too long, and fields it does not know', async () => {
      await http().post(`${API}/auth/google`).send({}).expect(400);
      await http()
        .post(`${API}/auth/google`)
        .send({ idToken: 'x'.repeat(4097) })
        .expect(400);
      await http()
        .post(`${API}/auth/google`)
        .send({ idToken: 'x', admin: true })
        .expect(400);
    });
  });

  describe('AC-6: one use per token', () => {
    it('refuses the same token the second time', async () => {
      const token = tok({ sub: 'g-1', email: 'jane@example.com' });
      await google(token).expect(200);

      const replay = await google(token).expect(401);

      expect(replay.body.code).toBe('AUTH-014');
      expect(await prisma.session.count()).toBe(1);
    });
  });

  describe('AC-7: the nonce', () => {
    it('must match when the token carries one', async () => {
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com', nonce: 'n-1' }),
        'n-1',
      ).expect(200);
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com', nonce: 'n-1' }),
        'other',
      ).expect(401);
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com', nonce: 'n-1' }),
      ).expect(401);
    });

    it('is refused when the request sends a nonce but the token has none: it did not come from that sign-in', async () => {
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com' }),
        'sent-anyway',
      ).expect(401);
    });

    it('is not needed when neither side has one', async () => {
      await google(tok({ sub: 'g-1', email: 'jane@example.com' })).expect(200);
    });
  });

  describe('AC-8: no taking over an account with a different Google account', () => {
    it('answers 409 when the account already has another Google account and a new one comes with the same email', async () => {
      await google(tok({ sub: 'g-A', email: 'jane@example.com' })).expect(200);

      const res = await google(
        tok({ sub: 'g-B', email: 'jane@example.com' }),
      ).expect(409);

      expect(res.body.code).toBe('AUTH-016');
      const user = await credentialsOf('jane@example.com');
      expect(
        user!.credentials
          .filter((c) => c.provider === 'GOOGLE')
          .map((c) => c.identifier),
      ).toEqual(['g-A']);
      expect(await prisma.session.count()).toBe(1);
    });
  });

  describe('AC-9: two first sign-ins at the same moment', () => {
    it('makes one account and lets both requests in, with no 500', async () => {
      const results = await Promise.all([
        google(tok({ sub: 'g-1', email: 'jane@example.com' })),
        google(tok({ sub: 'g-1', email: 'jane@example.com' })),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await prisma.user.count()).toBe(1);
      expect(
        await prisma.userCredential.count({ where: { provider: 'GOOGLE' } }),
      ).toBe(1);
      // exactly one of them created the account
      expect(results.filter((r) => r.body.data.isNewUser)).toHaveLength(1);
    });
  });

  describe('AC-10: linking a Google account to the account in use', () => {
    it('adds it, even when the Google email differs from the account email, and tells the owner at the account email', async () => {
      const session = await registerWithPassword('jane@example.com');

      await link(
        session.accessToken,
        tok({
          sub: 'g-1',
          email: 'jane.other@gmail.example.com',
          name: 'Jane G',
        }),
      ).expect(204);

      const user = await credentialsOf('jane@example.com');
      expect(user!.credentials.map((c) => c.provider).sort()).toEqual([
        'EMAIL',
        'GOOGLE',
      ]);
      const notice = mailbox.sent.find((m) => m.to === 'jane@example.com');
      expect(notice!.subject).toContain('Google');
      // and Google now logs in to this account
      const again = await google(
        tok({ sub: 'g-1', email: 'jane.other@gmail.example.com' }),
      ).expect(200);
      expect(again.body.data.isNewUser).toBe(false);
    });

    it('needs the current password: a stolen access token alone cannot add a way to log in', async () => {
      const session = await registerWithPassword('jane@example.com');
      const token = tok({ sub: 'g-1', email: 'attacker@example.com' });

      for (const wrong of [null, '', 'Wrong-Password-1!']) {
        const res = await link(session.accessToken, token, wrong).expect(400);
        expect(res.body.code).toBe('AUTH-012');
      }

      expect(
        await prisma.userCredential.count({ where: { provider: 'GOOGLE' } }),
      ).toBe(0);
      expect(mailbox.sent).toHaveLength(0);
      // the token was not used up by the refused tries: with the password it still works
      await link(session.accessToken, token).expect(204);
    });

    it('does nothing and succeeds when it is already linked to this account', async () => {
      const session = await registerWithPassword('jane@example.com');
      await link(
        session.accessToken,
        tok({ sub: 'g-1', email: 'j@example.com' }),
      ).expect(204);
      mailbox.sent.length = 0;

      await link(
        session.accessToken,
        tok({ sub: 'g-1', email: 'j@example.com' }),
      ).expect(204);

      expect(
        await prisma.userCredential.count({ where: { provider: 'GOOGLE' } }),
      ).toBe(1);
      expect(mailbox.sent).toHaveLength(0);
    });

    it('answers 409 for a Google account that belongs to somebody else, or a different one than the account has', async () => {
      await google(tok({ sub: 'g-taken', email: 'other@example.com' })).expect(
        200,
      );
      const session = await registerWithPassword('jane@example.com');

      const taken = await link(
        session.accessToken,
        tok({ sub: 'g-taken', email: 'x@example.com' }),
      ).expect(409);
      expect(taken.body.code).toBe('AUTH-016');

      await link(
        session.accessToken,
        tok({ sub: 'g-mine', email: 'x@example.com' }),
      ).expect(204);
      await link(
        session.accessToken,
        tok({ sub: 'g-another', email: 'x@example.com' }),
      ).expect(409);
    });

    it('allows only 5 tries per 15 minutes for one user, so the password cannot be guessed here', async () => {
      const session = await registerWithPassword('jane@example.com');

      for (let i = 0; i < 5; i++) {
        await link(
          session.accessToken,
          tok({ sub: `g-${i}`, email: 'x@example.com' }),
          'Wrong-Password-1!',
        ).expect(400);
      }

      await link(
        session.accessToken,
        tok({ sub: 'g-ok', email: 'x@example.com' }),
      ).expect(429);
    });

    it('needs a login', async () => {
      await http()
        .post(`${API}/auth/google/link`)
        .send({
          idToken: tok({ sub: 'g-1', email: 'a@example.com' }),
          currentPassword: PASSWORD,
        })
        .expect(401);
    });
  });

  describe('AC-11: unlinking', () => {
    it('removes Google when the user still has a password, and keeps the sessions', async () => {
      const session = await registerWithPassword('jane@example.com');
      await link(
        session.accessToken,
        tok({ sub: 'g-1', email: 'x@example.com' }),
      ).expect(204);

      await unlink(session.accessToken).expect(204);

      expect(
        await prisma.userCredential.count({ where: { provider: 'GOOGLE' } }),
      ).toBe(0);
      await me(session.accessToken).expect(200);
    });

    it('refuses with 400 when Google is the only way to log in', async () => {
      const res = await google(
        tok({ sub: 'g-1', email: 'jane@example.com' }),
      ).expect(200);

      const refused = await unlink(res.body.data.accessToken).expect(400);

      expect(refused.body.code).toBe('AUTH-017');
      expect(
        await prisma.userCredential.count({ where: { provider: 'GOOGLE' } }),
      ).toBe(1);
    });

    it('answers 404 when nothing is linked', async () => {
      const session = await registerWithPassword('jane@example.com');

      const res = await unlink(session.accessToken).expect(404);

      expect(res.body.code).toBe('AUTH-019');
    });

    it('needs a login', async () => {
      await http().delete(`${API}/auth/google`).expect(401);
    });
  });

  describe('AC-12: an account that only has Google', () => {
    it('behaves correctly in the other flows', async () => {
      const res = await google(
        tok({ sub: 'g-1', email: 'jane@example.com' }),
      ).expect(200);
      mailbox.sent.length = 0;

      // no password: the login answers like a wrong password
      await http()
        .post(`${API}/auth/login`)
        .send({ email: 'jane@example.com', password: PASSWORD })
        .expect(401);
      // the address cannot be registered again
      await http()
        .post(`${API}/auth/register`)
        .send({ email: 'jane@example.com', password: PASSWORD })
        .expect(409);
      // forgot-password answers like for any address, and sends nothing
      await http()
        .post(`${API}/auth/forgot-password`)
        .send({ email: 'jane@example.com' })
        .expect(202);
      expect(mailbox.sent).toHaveLength(0);
      // there is no password to change
      const change = await http()
        .post(`${API}/auth/change-password`)
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .send({
          currentPassword: PASSWORD,
          newPassword: '7-purple-Giraffes-dance',
        })
        .expect(400);
      expect(change.body.code).toBe('AUTH-012');
    });
  });

  describe('AC-14: when Google cannot be reached', () => {
    it('answers 503, not 401, and creates nothing', async () => {
      await google(
        tok({ sub: 'g-1', email: 'jane@example.com', unreachable: true }),
      ).expect(503);

      expect(await prisma.user.count()).toBe(0);
    });
  });

  describe('AC-15: limits', () => {
    it('allows 10 sign-ins per 15 minutes per client, good tokens included, then answers 429', async () => {
      for (let i = 0; i < 10; i++) {
        await google(tok({ sub: `g-${i}`, email: `u${i}@example.com` })).expect(
          200,
        );
      }

      await google(tok({ sub: 'g-x', email: 'x@example.com' })).expect(429);
    });
  });

  describe('AC-15: nothing sensitive is logged', () => {
    it('keeps the token, the email, the Google id and the name out of every log line, for success and for failure', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          vi
            .spyOn(Logger.prototype, level)
            .mockImplementation((message: any, ...rest: any[]) => {
              lines.push(JSON.stringify([message, ...rest]));
            }),
      );
      try {
        const good = tok({
          sub: 'sub-secret-xyz',
          email: 'private.person@example.com',
          name: 'Private Person',
        });
        await google(good).expect(200);
        await google(good).expect(401); // replay
        await google(
          tok({
            sub: 'sub-secret-xyz',
            email: 'private.person@example.com',
            verified: false,
          }),
        ).expect(403);
        await google(
          tok({
            sub: 'sub-other',
            email: 'private.person@example.com',
            broken: true,
          }),
        ).expect(401);
        await google(
          tok({
            sub: 'sub-other',
            email: 'private.person@example.com',
            unreachable: true,
          }),
        ).expect(503);
        const everything = lines.join('\n');

        for (const secret of [
          'sub-secret-xyz',
          'private.person@example.com',
          'Private Person',
          good,
        ]) {
          expect(everything).not.toContain(secret);
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  describe('AC-13: sign in with Google is not switched on', () => {
    it('answers 503 AUTH-018 while the rest of the app works', async () => {
      delete process.env.GOOGLE_CLIENT_IDS;
      const off = await buildApp();
      try {
        const res = await request(off.getHttpServer())
          .post(`${API}/auth/google`)
          .send({ idToken: tok({ sub: 'g-1', email: 'jane@example.com' }) })
          .expect(503);
        expect(res.body.code).toBe('AUTH-018');
        await request(off.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email: 'nobody@example.com', password: PASSWORD })
          .expect(401);
      } finally {
        await off.close();
        process.env.GOOGLE_CLIENT_IDS = CLIENT_ID;
      }
    });
  });
});
