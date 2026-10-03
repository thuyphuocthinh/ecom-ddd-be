import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { vi } from 'vitest';
import { CommandBus } from '@nestjs/cqrs';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  TokenStore,
  EMAIL_SENDER,
  AuthErrorCodes,
  HashUtil,
} from './../src/core/index.js';
import {
  AuthDomainException,
  GOOGLE_TOKEN_VERIFIER,
  type GoogleIdentity,
} from './../src/modules/auth/domain/index.js';
import {
  SessionIssuer,
  SuspendUserCommand,
} from './../src/modules/auth/application/index.js';

const API = '/api/v1';
const PASSWORD = 'Sunny-Giraffe-42!';
const CLIENT_ID = 'e2e-web.apps.googleusercontent.com';
const CLIENT = { ip: '203.0.113.7', userAgent: 'e2e' };

/** Stands in for Google: a "token" is just JSON saying what the real one would have proven. */
const fakeVerifier = {
  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const t = JSON.parse(idToken);
      return {
        sub: t.sub,
        email: t.email,
        emailVerified: true,
        expiresAt: new Date(Date.now() + 3600_000),
        tokenId: `${t.sub}:${t.n}`,
      };
    } catch {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
  },
};

describe('Account suspension (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let issuer: SessionIssuer;
  const original = { ...process.env };

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
  const me = (token: string) =>
    http().get(`${API}/users/me`).set(authed(token));
  const suspend = (token: string, id: string) =>
    http().post(`${API}/admin/users/${id}/suspend`).set(authed(token));
  const reinstate = (token: string, id: string) =>
    http().post(`${API}/admin/users/${id}/reinstate`).set(authed(token));
  const login = (email: string, password = PASSWORD) =>
    http().post(`${API}/auth/login`).send({ email, password });
  const refresh = (refreshToken: string) =>
    http().post(`${API}/auth/refresh`).send({ refreshToken });
  const googleSignIn = (sub: string, email: string) =>
    http()
      .post(`${API}/auth/google`)
      .send({ idToken: JSON.stringify({ sub, email, n: randomUUID() }) });

  /** An account made straight in the database, so no registration limit is spent */
  const createUser = async (
    email: string,
    role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER',
  ) => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        role,
        displayName: email,
        credentials: {
          create: [
            {
              id: randomUUID(),
              provider: 'EMAIL',
              identifier: email,
              secret: await HashUtil.hashPassword(PASSWORD),
            },
          ],
        },
      },
    });
    return { id, email, role };
  };

  /** A session started the same way every login starts one, without spending the login limit */
  const sessionFor = (user: { id: string; role: 'CUSTOMER' | 'ADMIN' }) =>
    issuer.start({ ...user, status: 'ACTIVE' }, CLIENT);

  const liveSessions = (userId: string) =>
    prisma.session.count({ where: { userId, revokedAt: null } });

  const statusOf = async (id: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id } })).status;

  const buildApp = async (): Promise<INestApplication> => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue({ async send() {} })
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

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_IDS = CLIENT_ID;
    app = await buildApp();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    issuer = app.get(SessionIssuer);
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...original };
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redis.getClient().flushdb();
  });

  describe('AC-1: suspending ends everything the account holds', () => {
    it('closes every session as ADMIN and refuses the access tokens and refresh tokens at once', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const adminSession = await sessionFor(admin);
      const phone = await sessionFor(victim);
      const laptop = await sessionFor(victim);
      await me(phone.accessToken).expect(200);
      await me(laptop.accessToken).expect(200);

      await suspend(adminSession.accessToken, victim.id).expect(204);

      expect(await statusOf(victim.id)).toBe('SUSPENDED');
      await me(phone.accessToken).expect(401);
      await me(laptop.accessToken).expect(401);
      await refresh(phone.refreshToken).expect(401);
      await refresh(laptop.refreshToken).expect(401);
      const rows = await prisma.session.findMany({
        where: { userId: victim.id },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revokedReason === 'ADMIN')).toBe(true);
      // the administrator and everybody else are not touched
      await me(adminSession.accessToken).expect(200);
    });

    it('refuses access tokens even of a session the database has no row for (the token version goes up)', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const adminSession = await sessionFor(admin);
      const lost = await sessionFor(victim);
      await prisma.session.deleteMany({ where: { userId: victim.id } });

      await suspend(adminSession.accessToken, victim.id).expect(204);

      await me(lost.accessToken).expect(401);
    });

    it('does not touch another user', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const bystander = await createUser('bystander@example.com');
      const adminSession = await sessionFor(admin);
      const bystanderSession = await sessionFor(bystander);

      await suspend(adminSession.accessToken, victim.id).expect(204);

      await me(bystanderSession.accessToken).expect(200);
      expect(await statusOf(bystander.id)).toBe('ACTIVE');
      expect(await liveSessions(bystander.id)).toBe(1);
    });
  });

  describe('AC-2: a suspended account cannot get in', () => {
    it('refuses the right password with 403 AUTH-020 and creates no session; a wrong password is still 401', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      await suspend((await sessionFor(admin)).accessToken, victim.id).expect(
        204,
      );

      const right = await login(victim.email).expect(403);
      const wrong = await login(victim.email, 'Wrong-Password-1!').expect(401);

      expect(right.body.code).toBe('AUTH-020');
      expect(wrong.body.code).toBe('AUTH-001');
      expect(await prisma.session.count({ where: { userId: victim.id } })).toBe(
        0,
      );
    });

    it('refuses Google sign-in of a linked Google account with 403 AUTH-020, and creates no session', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const first = await googleSignIn('g-1', 'gina@example.com').expect(200);
      const gina = await prisma.user.findFirstOrThrow({
        where: {
          credentials: { some: { provider: 'GOOGLE', identifier: 'g-1' } },
        },
      });
      await suspend((await sessionFor(admin)).accessToken, gina.id).expect(204);
      expect(first.body.data.isNewUser).toBe(true);

      const res = await googleSignIn('g-1', 'gina@example.com').expect(403);

      expect(res.body.code).toBe('AUTH-020');
      expect(await liveSessions(gina.id)).toBe(0);
    });

    it('refuses Google sign-in by email too, when the account was made with a password', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      await suspend((await sessionFor(admin)).accessToken, victim.id).expect(
        204,
      );

      const res = await googleSignIn('g-2', 'victim@example.com').expect(403);

      expect(res.body.code).toBe('AUTH-020');
      expect(await liveSessions(victim.id)).toBe(0);
      // nothing was changed on the locked-out account: no Google credential was linked to it
      const credentials = await prisma.userCredential.findMany({
        where: { userId: victim.id },
      });
      expect(credentials.map((c) => c.provider)).toEqual(['EMAIL']);
    });

    it('tells a stranger nothing: an unknown email and a suspended one answer a wrong password the same way', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      await suspend((await sessionFor(admin)).accessToken, victim.id).expect(
        204,
      );

      const suspendedWrong = await login(victim.email, 'Wrong-Password-1!');
      const unknownWrong = await login(
        'nobody@example.com',
        'Wrong-Password-1!',
      );

      expect(suspendedWrong.status).toBe(unknownWrong.status);
      expect(suspendedWrong.body.code).toBe(unknownWrong.body.code);
    });
  });

  describe('AC-3: reinstating', () => {
    it('lets the person log in again, and the old sessions stay closed', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const adminToken = (await sessionFor(admin)).accessToken;
      const before = await sessionFor(victim);
      await suspend(adminToken, victim.id).expect(204);

      await reinstate(adminToken, victim.id).expect(204);

      expect(await statusOf(victim.id)).toBe('ACTIVE');
      const fresh = await login(victim.email).expect(200);
      await me(fresh.body.data.accessToken).expect(200);
      await me(before.accessToken).expect(401);
      await refresh(before.refreshToken).expect(401);
    });
  });

  describe('AC-4: only an administrator', () => {
    it('answers 401 without a login and 403 for a customer, and changes nothing', async () => {
      const customer = await createUser('customer@example.com');
      const victim = await createUser('victim@example.com');
      const customerSession = await sessionFor(customer);
      await sessionFor(victim);

      await http().post(`${API}/admin/users/${victim.id}/suspend`).expect(401);
      await suspend(customerSession.accessToken, victim.id).expect(403);
      await reinstate(customerSession.accessToken, victim.id).expect(403);

      expect(await statusOf(victim.id)).toBe('ACTIVE');
      expect(await liveSessions(victim.id)).toBe(1);
    });

    it('a customer cannot suspend themselves either', async () => {
      const customer = await createUser('customer@example.com');
      const session = await sessionFor(customer);

      await suspend(session.accessToken, customer.id).expect(403);

      expect(await statusOf(customer.id)).toBe('ACTIVE');
    });
  });

  describe('AC-5: an administrator cannot be suspended', () => {
    it('refuses with 403 AUTH-021, for another administrator and for oneself, and closes nothing', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const other = await createUser('other-admin@example.com', 'ADMIN');
      const adminSession = await sessionFor(admin);
      await sessionFor(other);

      const another = await suspend(adminSession.accessToken, other.id).expect(
        403,
      );
      const oneself = await suspend(adminSession.accessToken, admin.id).expect(
        403,
      );

      expect(another.body.code).toBe('AUTH-021');
      expect(oneself.body.code).toBe('AUTH-021');
      expect(await statusOf(other.id)).toBe('ACTIVE');
      expect(await liveSessions(other.id)).toBe(1);
      await me(adminSession.accessToken).expect(200);
    });
  });

  describe('AC-6: unknown users and repeats', () => {
    it('answers 404 USR-001 for a user that does not exist and 400 for an id that is not one', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const token = (await sessionFor(admin)).accessToken;

      const missing = await suspend(token, randomUUID()).expect(404);
      await reinstate(token, randomUUID()).expect(404);
      await suspend(token, 'not-an-id').expect(400);

      expect(missing.body.code).toBe('USR-001');
    });

    it('suspending twice, and reinstating an active account, both answer 204', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const token = (await sessionFor(admin)).accessToken;

      await suspend(token, victim.id).expect(204);
      await suspend(token, victim.id).expect(204);
      await reinstate(token, victim.id).expect(204);
      await reinstate(token, victim.id).expect(204);

      expect(await statusOf(victim.id)).toBe('ACTIVE');
    });
  });

  describe('AC-7: a login at the very moment of the suspension', () => {
    it('never leaves a live session behind, over many tries', async () => {
      const victim = await createUser('victim@example.com');
      const commands = app.get(CommandBus);
      const tokensGivenOut: string[] = [];

      for (let round = 0; round < 25; round++) {
        await prisma.user.update({
          where: { id: victim.id },
          data: { status: 'ACTIVE' },
        });
        const [login, suspension] = await Promise.allSettled([
          sessionFor(victim),
          commands.execute(new SuspendUserCommand(victim.id, 'e2e-actor')),
        ]);
        if (login.status === 'fulfilled') {
          tokensGivenOut.push(login.value.accessToken);
        } else {
          expect(login.reason.code).toBe('AUTH-020');
        }
        expect(suspension.status).toBe('fulfilled');
        expect(await statusOf(victim.id)).toBe('SUSPENDED');
        // whichever side won, nothing of the victim may be alive
        expect(await liveSessions(victim.id)).toBe(0);
      }

      // a login that did get tokens was closed right after: the tokens are dead
      for (const token of tokensGivenOut) {
        await me(token).expect(401);
      }
    });
  });

  describe('AC-2: the refresh grace window', () => {
    it('hands back nothing usable after a suspension: the pair given by a refresh a moment ago is dead', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const first = await sessionFor(victim);
      const rotated = await refresh(first.refreshToken).expect(200);
      await suspend((await sessionFor(admin)).accessToken, victim.id).expect(
        204,
      );

      // the old token is still inside the grace window, so it answers with the pair made earlier
      const again = await refresh(first.refreshToken);
      const pair = again.status === 200 ? again.body.data : rotated.body.data;

      await me(pair.accessToken).expect(401);
      await refresh(pair.refreshToken).expect(401);
    });
  });

  describe('AC-8: Redis fails while suspending', () => {
    it('answers 503, keeps the account suspended with its sessions closed, and a second request finishes the job', async () => {
      const admin = await createUser('admin@example.com', 'ADMIN');
      const victim = await createUser('victim@example.com');
      const adminToken = (await sessionFor(admin)).accessToken;
      const victimSession = await sessionFor(victim);
      const store = app.get(TokenStore);
      const broken = vi
        .spyOn(store, 'bumpTokenVersion')
        .mockRejectedValue(new Error('ECONNREFUSED'));

      await suspend(adminToken, victim.id).expect(503);

      expect(await statusOf(victim.id)).toBe('SUSPENDED');
      expect(await liveSessions(victim.id)).toBe(0);
      await refresh(victimSession.refreshToken).expect(401);
      await login(victim.email).expect(403);

      broken.mockRestore();
      await suspend(adminToken, victim.id).expect(204);
      await me(victimSession.accessToken).expect(401);
    });
  });
});
