import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  CACHE,
  EMAIL_SENDER,
} from './../src/core/index.js';
import type { EmailMessage } from './../src/core/index.js';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { JwtService } from '@nestjs/jwt';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const API = '/api/v1';

/**
 * Stands in for the real email provider: keeps what would have been sent, so a test can
 * read the code, and can be told to fail like a provider outage.
 */
const mailbox = {
  sent: [] as EmailMessage[],
  failing: false,
  async send(message: EmailMessage): Promise<void> {
    if (this.failing) throw new Error('provider down');
    this.sent.push(message);
  },
};

/** The 6-digit code in the latest email sent to `email` */
function codeSentTo(email: string): string {
  const address = email.trim().toLowerCase();
  const message = [...mailbox.sent].reverse().find((m) => m.to === address);
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`No code was emailed to ${email}`);
  return match[1];
}

/** A code of the right shape that is not `code` */
const wrongCodeFor = (code: string) =>
  code === '000000' ? '111111' : '000000';

/** Start a registration (code gets emailed, no account yet) */
function startRegistration(
  app: INestApplication,
  email: string,
  password = 'Sunny-Giraffe-42!',
) {
  return request(app.getHttpServer())
    .post(`${API}/auth/register`)
    .send({ email, password });
}

const DEFAULT_PASSWORD = 'Sunny-Giraffe-42!';

function verifyEmail(
  app: INestApplication,
  email: string,
  code: string,
  password = DEFAULT_PASSWORD,
) {
  return request(app.getHttpServer())
    .post(`${API}/auth/verify-email`)
    .send({ email, code, password });
}

/** Register a new user (including the email confirmation) and return { email, password } */
async function registerUser(
  app: INestApplication,
  email = `test-${Date.now()}@example.com`,
  password = 'Sunny-Giraffe-42!',
): Promise<{ email: string; password: string }> {
  await startRegistration(app, email, password).expect(202);
  await verifyEmail(app, email, codeSentTo(email), password).expect(200);
  // Confirming the email also logs the new user in; tests that want sessions create their own
  await app.get(PrismaService).session.deleteMany({
    where: {
      user: {
        credentials: { some: { identifier: email.trim().toLowerCase() } },
      },
    },
  });
  return { email, password };
}

/** Login and return { accessToken, refreshToken } */
async function loginUser(
  app: INestApplication,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/login`)
    .send({ email, password })
    .expect(200);
  return res.body.data;
}

/** Login from a given "device" (User-Agent) and return { accessToken, refreshToken } */
async function loginFrom(
  app: INestApplication,
  email: string,
  password: string,
  userAgent: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/login`)
    .set('User-Agent', userAgent)
    .send({ email, password })
    .expect(200);
  return res.body.data;
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Register then immediately login, returns tokens */
async function registerAndLogin(app: INestApplication, email?: string) {
  const { email: e, password: p } = await registerUser(app, email);
  return loginUser(app, e, p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let redisStore: any;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    const clsService = app.get(ClsService);
    app.useGlobalFilters(new AllExceptionsFilter(clsService));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix(API.replace('/', ''));

    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    // Get RedisService to flush redis before each test
    const { RedisService } = await import('./../src/core/index.js');
    redisStore = app.get(RedisService);
    if (!redisStore) throw new Error('RedisService not found');
  });

  // The session id (`sid`) carried inside an access token
  const sidOf = (accessToken: string): string =>
    (jwtService.decode(accessToken) as { sid: string }).sid;

  const authHeader = (tokens: { accessToken: string }) =>
    `Bearer ${tokens.accessToken}`;

  beforeEach(async () => {
    // Clean auth-related data before each test (sessions go with their user)
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redisStore.getClient().flushdb();
    mailbox.sent.length = 0;
    mailbox.failing = false;
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-1: Register — success (two steps: code by email, then verify)
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-1: register then verify-email — creates the account', () => {
    it('register answers 202 and creates no account; verify-email then creates it and returns tokens', async () => {
      const res = await startRegistration(app, 'new@example.com').expect(202);

      expect(res.body.data).toEqual({
        verificationRequired: true,
        resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
        verificationExpiresInSeconds: CACHE.AUTH.SETTINGS.PENDING_SIGNUP_TTL,
      });
      expect(await prisma.user.count()).toBe(0);

      const verified = await verifyEmail(
        app,
        'new@example.com',
        codeSentTo('new@example.com'),
      ).expect(200);

      expect(typeof verified.body.data.accessToken).toBe('string');
      expect(typeof verified.body.data.refreshToken).toBe('string');
      expect(await prisma.user.count()).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-2: Register — duplicate email
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-2: POST /auth/register — email that already has an account → 409', () => {
    it('returns 409 Conflict with a generic message, and sends no code', async () => {
      await registerUser(app, 'dup@example.com');
      mailbox.sent.length = 0;

      const res = await startRegistration(app, 'dup@example.com').expect(409);

      // Error message MUST NOT reveal the exact email
      expect(JSON.stringify(res.body)).not.toContain('dup@example.com');
      expect(mailbox.sent).toHaveLength(0);
    });
  });

  describe('AC-2b: email is case-insensitive', () => {
    it('treats A@x.com and a@x.com as the same account (409), and login works with either casing', async () => {
      await registerUser(app, 'Mixed.Case@Example.com');

      await startRegistration(app, 'mixed.case@example.com').expect(409);

      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({
          email: '  MIXED.CASE@example.com ',
          password: 'Sunny-Giraffe-42!',
        })
        .expect(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Password policy: strength is judged when a password is chosen, never on login
  // ───────────────────────────────────────────────────────────────────────────
  describe('Password policy', () => {
    it('refuses a common password with 400 AUTH-010 and the reason, sending no code', async () => {
      const res = await startRegistration(
        app,
        'new@example.com',
        'Password123!',
      ).expect(400);

      expect(res.body.code).toBe('AUTH-010');
      expect(res.body.errors).toEqual({ reason: 'COMMON' });
      expect(mailbox.sent).toHaveLength(0);
      expect(await prisma.user.count()).toBe(0);
    });

    it('refuses a password built from the email, and one shorter than 8 characters', async () => {
      const own = await startRegistration(
        app,
        'new.person@example.com',
        'xx-new.person-9Z',
      ).expect(400);
      expect(own.body.errors).toEqual({ reason: 'CONTAINS_EMAIL' });

      await startRegistration(app, 'new@example.com', 'Ab1!').expect(400);
      expect(mailbox.sent).toHaveLength(0);
    });

    it('a refused password does not use up the address cooldown: a better one goes straight through', async () => {
      await startRegistration(app, 'new@example.com', 'qwertyuiop').expect(400);

      await startRegistration(app, 'new@example.com').expect(202);
      expect(mailbox.sent).toHaveLength(1);
    });

    it('login does not judge strength: a weak but well-formed password gets as far as the credential check (401, not 400)', async () => {
      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'someone@example.com', password: 'password' })
        .expect(401);
    });

    it.each([
      [
        'an email that is not one',
        { email: 'not-an-email', password: 'long-enough-1' },
      ],
      ['an empty password', { email: 'a@example.com', password: '' }],
      [
        'a password under 8 characters',
        { email: 'a@example.com', password: '1234567' },
      ],
      [
        'a password that is not a string',
        { email: 'a@example.com', password: 12345678 },
      ],
      [
        'a password over 128 characters',
        { email: 'a@example.com', password: 'x'.repeat(129) },
      ],
      [
        'an email over 254 characters',
        { email: `${'a'.repeat(250)}@example.com`, password: 'long-enough-1' },
      ],
      [
        'a field it does not know',
        { email: 'a@example.com', password: 'long-enough-1', admin: true },
      ],
    ])(
      'login rejects %s with 400 before looking anyone up',
      async (_name, body) => {
        await request(app.getHttpServer())
          .post(`${API}/auth/login`)
          .send(body)
          .expect(400);
      },
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-3: Login — success, AT + RT in body
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-3: POST /auth/login — success → { accessToken, refreshToken }', () => {
    it('returns 200 with AT and RT in response body', async () => {
      const { email, password } = await registerUser(app);

      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password })
        .expect(200);

      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
      expect(typeof res.body.data.accessToken).toBe('string');
      expect(typeof res.body.data.refreshToken).toBe('string');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-4: Login — wrong password
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-4: POST /auth/login — wrong password → 401 generic', () => {
    it('returns 401 with a generic message (no hint about existence)', async () => {
      await registerUser(app, 'real@example.com');

      const res = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'real@example.com', password: 'WrongPass123!' })
        .expect(401);

      const msg = (res.body.message ?? '').toLowerCase();
      expect(msg).not.toContain('not found');
      expect(msg).not.toContain('exist');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-5: Rate limit — login (off-by-one boundary)
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-5: Rate limit login — 429 after 5 attempts', () => {
    it('allows 5 attempts but blocks the 6th', async () => {
      for (let i = 1; i <= 5; i++) {
        const res = await request(app.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email: `nouser${i}@example.com`, password: 'long-enough-1' });
        // Responses 1-5 should NOT be 429
        expect(res.status).not.toBe(429);
      }

      // 6th attempt must be blocked
      const blocked = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'nouser6@example.com', password: 'long-enough-1' })
        .expect(429);

      expect(blocked.body).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-6: AT expired → 401
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-6: Expired AT → 401 on protected route', () => {
    it('returns 401 when using an already-expired access token', async () => {
      // Sign a token that expired 1 second ago
      const expiredAt = jwtService.sign(
        { sub: 'user-fake', role: 'CUSTOMER', ver: 0 },
        { expiresIn: -1 },
      );

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${expiredAt}`)
        .expect(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-7: Refresh — success + RT rotation
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-7: POST /auth/refresh — returns new tokens, same session', () => {
    it('issues a new AT and RT for the same session (sid unchanged)', async () => {
      const tokens = await registerAndLogin(app);

      const refreshRes = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const newTokens = refreshRes.body.data;
      expect(newTokens).toHaveProperty('accessToken');
      expect(newTokens).toHaveProperty('refreshToken');
      expect(newTokens.refreshToken).not.toBe(tokens.refreshToken);
      expect(sidOf(newTokens.accessToken)).toBe(sidOf(tokens.accessToken));
    });

    it('updates the session: new token hash in, old one kept as previous, last use moves forward', async () => {
      const tokens = await registerAndLogin(app);
      const before = await prisma.session.findFirstOrThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const after = await prisma.session.findFirstOrThrow();
      expect(after.id).toBe(before.id);
      expect(after.refreshTokenHash).toBe(sha256(res.body.data.refreshToken));
      expect(after.previousRefreshTokenHash).toBe(sha256(tokens.refreshToken));
      expect(after.lastUsedAt.getTime()).toBeGreaterThan(
        before.lastUsedAt.getTime(),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-8: Reuse — an already-rotated RT is rejected once the grace window is over
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-8: POST /auth/refresh — rotated RT reused after the grace window → 401 and the session is revoked', () => {
    // "More than 15 seconds later": drop the grace entry and age the rotation
    const pastGraceWindow = async (
      oldRefreshToken: string,
      sessionId: string,
    ) => {
      await redisStore
        .getClient()
        .del(CACHE.AUTH.KEYS.ROTATION_GRACE(sha256(oldRefreshToken)));
      await prisma.session.update({
        where: { id: sessionId },
        data: { rotatedAt: new Date(Date.now() - 60_000) },
      });
    };

    it('rejects the old RT, revokes that session (so the newer RT stops working too), and leaves other devices alone', async () => {
      const { email, password } = await registerUser(app);
      const stolen = await loginFrom(app, email, password, 'Device-A');
      const other = await loginFrom(app, email, password, 'Device-B');

      const rotated = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: stolen.refreshToken })
        .expect(200);
      await pastGraceWindow(stolen.refreshToken, sidOf(stolen.accessToken));

      // The attacker replays the old token
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: stolen.refreshToken })
        .expect(401);

      const session = await prisma.session.findUniqueOrThrow({
        where: { id: sidOf(stolen.accessToken) },
      });
      expect(session.revokedReason).toBe('REUSE_DETECTED');

      // The token the legitimate client got is dead as well
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(rotated.body.data))
        .expect(401);

      // The user's other device is untouched
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: other.refreshToken })
        .expect(200);
    });

    it('does not revoke when the old RT is replayed inside the window but its grace entry is gone', async () => {
      const tokens = await registerAndLogin(app);
      const rotated = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
      await redisStore
        .getClient()
        .del(CACHE.AUTH.KEYS.ROTATION_GRACE(sha256(tokens.refreshToken)));

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      // The session survived: the RT it was rotated into still works
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-9: Grace Window — concurrent refresh
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-9: Grace Window — two concurrent refreshes return same tokens', () => {
    it('both requests with the same RT return identical token pairs within 15s, and the session rotates once', async () => {
      const tokens = await registerAndLogin(app);

      // Fire two requests genuinely in parallel with the same RT
      const send = () =>
        request(app.getHttpServer())
          .post(`${API}/auth/refresh`)
          .send({ refreshToken: tokens.refreshToken });
      const [res1, res2] = await Promise.all([send(), send()]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      // Both should return identical token pairs
      expect(res1.body.data.accessToken).toBe(res2.body.data.accessToken);
      expect(res1.body.data.refreshToken).toBe(res2.body.data.refreshToken);

      // ...and only one rotation happened: the stored token is that pair's RT
      const session = await prisma.session.findFirstOrThrow();
      expect(session.refreshTokenHash).toBe(
        sha256(res1.body.data.refreshToken),
      );
      expect(session.previousRefreshTokenHash).toBe(
        sha256(tokens.refreshToken),
      );
    });

    it('a sequential replay of the old RT inside the window gets the same pair and does not revoke the session', async () => {
      const tokens = await registerAndLogin(app);
      const first = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const replay = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      expect(replay.body.data).toEqual(first.body.data);
      const session = await prisma.session.findFirstOrThrow();
      expect(session.revokedAt).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-10: Logout
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-10: POST /auth/logout — ends the current session', () => {
    it('returns 204; the AT is rejected at once and the RT can no longer refresh', async () => {
      const { email, password } = await registerUser(app);
      const tokens = await loginUser(app, email, password);

      // Verify the AT works before logout
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(tokens))
        .expect(200);

      await request(app.getHttpServer())
        .post(`${API}/auth/logout`)
        .set('Authorization', authHeader(tokens))
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(tokens))
        .expect(401);
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      const session = await prisma.session.findFirstOrThrow();
      expect(session.revokedReason).toBe('LOGOUT');
    });

    it('works without a body (the refreshToken field is optional)', async () => {
      const tokens = await registerAndLogin(app);

      await request(app.getHttpServer())
        .post(`${API}/auth/logout`)
        .set('Authorization', authHeader(tokens))
        .expect(204);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(tokens))
        .expect(401);
    });

    it('only ends that session: another device of the same user keeps working', async () => {
      const { email, password } = await registerUser(app);
      const a = await loginFrom(app, email, password, 'Device-A');
      const b = await loginFrom(app, email, password, 'Device-B');

      await request(app.getHttpServer())
        .post(`${API}/auth/logout`)
        .set('Authorization', authHeader(a))
        .expect(204);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(b))
        .expect(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-11: Logout All
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-11: POST /auth/logout-all — every session ended', () => {
    it('returns 204; ATs and RTs of all devices stop working', async () => {
      const { email, password } = await registerUser(app);

      // Login on device 1 and device 2
      const device1 = await loginFrom(app, email, password, 'Device-1');
      const device2 = await loginFrom(app, email, password, 'Device-2');

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(device1))
        .expect(200);

      // Logout all from device 2
      await request(app.getHttpServer())
        .post(`${API}/auth/logout-all`)
        .set('Authorization', authHeader(device2))
        .expect(204);

      for (const device of [device1, device2]) {
        await request(app.getHttpServer())
          .get(`${API}/users/me`)
          .set('Authorization', authHeader(device))
          .expect(401);
        await request(app.getHttpServer())
          .post(`${API}/auth/refresh`)
          .send({ refreshToken: device.refreshToken })
          .expect(401);
      }

      const sessions = await prisma.session.findMany();
      expect(sessions).toHaveLength(2);
      expect(sessions.every((x) => x.revokedReason === 'LOGOUT_ALL')).toBe(
        true,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-12: RBAC — CUSTOMER cannot call ADMIN endpoint
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-12: RBAC — CUSTOMER → POST /catalog/products → 403', () => {
    it('returns 403 Forbidden when a CUSTOMER tries to create a product', async () => {
      const tokens = await registerAndLogin(app); // default role is CUSTOMER

      await request(app.getHttpServer())
        .post(`${API}/catalog/products`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ name: 'Hack Product', categoryId: 'fake', skus: [] })
        .expect(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-13: RBAC — ADMIN can call ADMIN endpoint
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-13: RBAC — ADMIN → POST /catalog/products → not 401/403', () => {
    it('an ADMIN token passes JWT + RBAC guards (may fail for other business reasons but not auth)', async () => {
      // Promote a user to ADMIN directly in DB to simulate an admin user
      const { email, password } = await registerUser(app, 'admin@example.com');
      await prisma.user.updateMany({
        where: { credentials: { some: { identifier: email } } },
        data: { role: 'ADMIN' },
      });

      const tokens = await loginUser(app, email, password);

      const res = await request(app.getHttpServer())
        .post(`${API}/catalog/products`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ name: 'Admin Product', categoryId: 'non-existent', skus: [] });

      // Must NOT be 401 or 403 — auth passed. Business error (404 category) is acceptable.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
  // ═══════════════════════════════════════════════════════════════════════════
  // Sessions — device list and per-device revocation (spec: auth-sessions)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Sessions AC-1: login creates a session for the device', () => {
    it('stores the device and only the hash of the RT; the AT carries the session id', async () => {
      const { email, password } = await registerUser(app);

      const tokens = await loginFrom(app, email, password, 'Chrome-E2E/128');

      const sessions = await prisma.session.findMany();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sidOf(tokens.accessToken),
        deviceName: 'Chrome-E2E/128',
        refreshTokenHash: sha256(tokens.refreshToken),
        revokedAt: null,
      });
      expect(sessions[0].ipAddress).not.toBe('');
    });
  });

  describe('Sessions AC-2: GET /auth/sessions — list devices', () => {
    it('lists live sessions, marks the current one, and exposes no sensitive fields', async () => {
      const { email, password } = await registerUser(app);
      const a = await loginFrom(app, email, password, 'Device-A');
      await loginFrom(app, email, password, 'Device-B');

      const res = await request(app.getHttpServer())
        .get(`${API}/auth/sessions`)
        .set('Authorization', authHeader(a))
        .expect(200);

      const list = res.body.data;
      expect(list).toHaveLength(2);
      expect(list.filter((s: any) => s.current)).toHaveLength(1);
      expect(list.find((s: any) => s.current).id).toBe(sidOf(a.accessToken));
      expect(list.map((s: any) => s.deviceName).sort()).toEqual([
        'Device-A',
        'Device-B',
      ]);
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'current',
          'deviceName',
          'id',
          'ipAddress',
          'lastUsedAt',
        ]);
      }
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get(`${API}/auth/sessions`)
        .expect(401);
    });
  });

  describe('Sessions AC-3: DELETE /auth/sessions/:id — log out another device', () => {
    it("returns 204; that device's AT is refused at once and its RT cannot refresh; the caller is unaffected", async () => {
      const { email, password } = await registerUser(app);
      const a = await loginFrom(app, email, password, 'Device-A');
      const b = await loginFrom(app, email, password, 'Device-B');

      await request(app.getHttpServer())
        .delete(`${API}/auth/sessions/${sidOf(b.accessToken)}`)
        .set('Authorization', authHeader(a))
        .expect(204);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(b))
        .expect(401);
      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: b.refreshToken })
        .expect(401);
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(a))
        .expect(200);
    });
  });

  describe("Sessions AC-4: cannot revoke another user's session", () => {
    it("returns 404 and leaves the other user's session working", async () => {
      const userX = await registerUser(app, 'x@example.com');
      const userY = await registerUser(app, 'y@example.com');
      const x = await loginUser(app, userX.email, userX.password);
      const y = await loginUser(app, userY.email, userY.password);

      await request(app.getHttpServer())
        .delete(`${API}/auth/sessions/${sidOf(y.accessToken)}`)
        .set('Authorization', authHeader(x))
        .expect(404);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(y))
        .expect(200);
    });

    it('returns 404 for a session that does not exist', async () => {
      const tokens = await registerAndLogin(app);

      await request(app.getHttpServer())
        .delete(`${API}/auth/sessions/does-not-exist`)
        .set('Authorization', authHeader(tokens))
        .expect(404);
    });
  });

  describe('Sessions AC-6: POST /auth/sessions/revoke-others', () => {
    it('returns 204, ends every other device and keeps the current one', async () => {
      const { email, password } = await registerUser(app);
      const a = await loginFrom(app, email, password, 'Device-A');
      const b = await loginFrom(app, email, password, 'Device-B');
      const c = await loginFrom(app, email, password, 'Device-C');

      await request(app.getHttpServer())
        .post(`${API}/auth/sessions/revoke-others`)
        .set('Authorization', authHeader(a))
        .expect(204);

      for (const other of [b, c]) {
        await request(app.getHttpServer())
          .get(`${API}/users/me`)
          .set('Authorization', authHeader(other))
          .expect(401);
      }
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(a))
        .expect(200);

      const list = await request(app.getHttpServer())
        .get(`${API}/auth/sessions`)
        .set('Authorization', authHeader(a))
        .expect(200);
      expect(list.body.data).toHaveLength(1);
    });
  });

  describe('Sessions AC-12: expired session', () => {
    it('is not listed and its RT cannot refresh', async () => {
      const { email, password } = await registerUser(app);
      const a = await loginFrom(app, email, password, 'Device-A');
      const b = await loginFrom(app, email, password, 'Device-B');
      await prisma.session.update({
        where: { id: sidOf(b.accessToken) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const list = await request(app.getHttpServer())
        .get(`${API}/auth/sessions`)
        .set('Authorization', authHeader(a))
        .expect(200);
      expect(list.body.data).toHaveLength(1);

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: b.refreshToken })
        .expect(401);
    });
  });

  describe('Sessions AC-14: absolute lifetime', () => {
    const DAY = 86_400_000;
    const ABSOLUTE_LIFETIME = 30 * DAY;

    it('a refresh near the end of the 30 days extends the session only up to the cap, not another 7 days', async () => {
      const tokens = await registerAndLogin(app);
      // A session that logged in 29 days ago and has been refreshed ever since
      const createdAt = new Date(Date.now() - 29 * DAY);
      await prisma.session.updateMany({
        data: {
          createdAt,
          expiresAt: new Date(createdAt.getTime() + ABSOLUTE_LIFETIME),
        },
      });

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const session = await prisma.session.findFirstOrThrow();
      expect(session.expiresAt.getTime()).toBe(
        createdAt.getTime() + ABSOLUTE_LIFETIME,
      );
    });

    it('once the 30 days are over the session can no longer refresh and must log in again', async () => {
      const { email, password } = await registerUser(app);
      const tokens = await loginFrom(app, email, password, 'Device-A');
      const createdAt = new Date(Date.now() - 30 * DAY - 1000);
      await prisma.session.updateMany({
        data: {
          createdAt,
          expiresAt: new Date(createdAt.getTime() + ABSOLUTE_LIFETIME),
        },
      });

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      // ...and logging in again starts a fresh session
      const again = await loginFrom(app, email, password, 'Device-A');
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(again))
        .expect(200);
    });
  });

  describe('Sessions: access token from before sessions existed', () => {
    it('is rejected (no sid) so the client logs in again', async () => {
      const legacyToken = jwtService.sign({
        sub: 'user-fake',
        role: 'CUSTOMER',
        ver: 0,
      });

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${legacyToken}`)
        .expect(401);
    });
  });
  // ═══════════════════════════════════════════════════════════════════════════
  // Verification — confirming the email with a one-time code (spec: auth-verification)
  // ═══════════════════════════════════════════════════════════════════════════

  const forgetCooldown = (email: string) =>
    redisStore
      .getClient()
      .del(CACHE.AUTH.KEYS.OTP_COOLDOWN('REGISTER_EMAIL', sha256(email)));

  const resendFor = (email: string) =>
    request(app.getHttpServer())
      .post(`${API}/auth/resend-verification`)
      .send({ email });

  describe('Verification AC-1: register emails a code and creates no account', () => {
    it('sends one 6-digit code to the address and never returns it', async () => {
      const res = await startRegistration(app, 'new@example.com').expect(202);

      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0].to).toBe('new@example.com');
      const code = codeSentTo('new@example.com');
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(code);
      expect(await prisma.userCredential.count()).toBe(0);
    });
  });

  describe('Verification AC-2: the right code creates the account and logs in', () => {
    it('stores the registered password hash, starts a session and removes the pending registration', async () => {
      await startRegistration(
        app,
        'new@example.com',
        'Sunny-Giraffe-42!',
      ).expect(202);

      const res = await verifyEmail(
        app,
        'new@example.com',
        codeSentTo('new@example.com'),
      ).expect(200);

      const credential = await prisma.userCredential.findFirstOrThrow();
      expect(credential.identifier).toBe('new@example.com');
      expect(credential.secret).toMatch(/^\$argon2id\$/);
      expect(sidOf(res.body.data.accessToken)).toBe(
        (await prisma.session.findFirstOrThrow()).id,
      );
      expect(
        await redisStore
          .getClient()
          .exists(CACHE.AUTH.KEYS.PENDING_SIGNUP(sha256('new@example.com'))),
      ).toBe(0);
      await loginUser(app, 'new@example.com', 'Sunny-Giraffe-42!');
    });

    it('lets the new user call a protected route with the returned token', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const res = await verifyEmail(
        app,
        'new@example.com',
        codeSentTo('new@example.com'),
      ).expect(200);

      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', authHeader(res.body.data))
        .expect(200);
    });
  });

  describe('Verification AC-3: wrong codes lock the guesser out, not the owner', () => {
    const otpKey = () =>
      CACHE.AUTH.KEYS.OTP('REGISTER_EMAIL', sha256('new@example.com'));

    it('answers 400 with the same message each time; after 5 wrong tries even the right code fails for that client', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');
      const wrong = wrongCodeFor(code);

      const messages = new Set<string>();
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await verifyEmail(app, 'new@example.com', wrong).expect(
          400,
        );
        messages.add(res.body.message);
      }
      expect(messages.size).toBe(1);

      await verifyEmail(app, 'new@example.com', code).expect(400);
      expect(await prisma.user.count()).toBe(0);
    });

    it('a client that used up its guesses does not destroy the code: another client can still confirm it', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');
      // Somebody else (another IP) has already used up all their guesses
      await redisStore
        .getClient()
        .hset(otpKey(), `c:${sha256('198.51.100.9')}`, 5);

      await verifyEmail(app, 'new@example.com', code).expect(200);
    });

    it('destroys the code once all clients together have guessed too often', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');
      await redisStore
        .getClient()
        .hset(otpKey(), 'attempts', CACHE.AUTH.SETTINGS.OTP_MAX_ATTEMPTS_TOTAL);

      await verifyEmail(app, 'new@example.com', wrongCodeFor(code)).expect(400);

      await verifyEmail(app, 'new@example.com', code).expect(400);
      expect(await redisStore.getClient().exists(otpKey())).toBe(0);
    });
  });

  describe('Verification AC-4: expired, used or unknown codes all look the same', () => {
    it('rejects a wrong code, an expired code, a used code and an unknown address with one message', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');

      const wrongCode = await verifyEmail(
        app,
        'new@example.com',
        wrongCodeFor(code),
      ).expect(400);
      const unknown = await verifyEmail(
        app,
        'nobody@example.com',
        '123456',
      ).expect(400);

      // expired: the code's key has timed out
      await redisStore
        .getClient()
        .del(CACHE.AUTH.KEYS.OTP('REGISTER_EMAIL', sha256('new@example.com')));
      const expired = await verifyEmail(app, 'new@example.com', code).expect(
        400,
      );

      expect(
        new Set([wrongCode, unknown, expired].map((r) => r.body.message)).size,
      ).toBe(1);
    });

    it('rejects a code that was already used', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');
      await verifyEmail(app, 'new@example.com', code).expect(200);

      await verifyEmail(app, 'new@example.com', code).expect(400);
    });

    it('rejects input that is not a 6-digit code before looking anything up', async () => {
      await verifyEmail(app, 'new@example.com', '12345').expect(400);
      await verifyEmail(app, 'new@example.com', 'abcdef').expect(400);
    });
  });

  describe('Verification AC-5: resend has a cooldown and replaces the old code', () => {
    it('answers 429 while in cooldown; afterwards sends a new code and the old one stops working', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const first = codeSentTo('new@example.com');

      // Still in cooldown: refused, and told how long is left
      const refused = await resendFor('new@example.com').expect(429);
      const wait = refused.body.errors.retryAfterSeconds;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN);
      expect(Number(refused.headers['retry-after'])).toBe(wait);

      await forgetCooldown('new@example.com');
      await resendFor('new@example.com').expect(202);
      const second = codeSentTo('new@example.com');
      expect(mailbox.sent).toHaveLength(2);

      if (first !== second) {
        await verifyEmail(app, 'new@example.com', first).expect(400);
      }
      await verifyEmail(app, 'new@example.com', second).expect(200);
    });
  });

  describe('Verification AC-6: at most 5 codes per address per hour', () => {
    it('answers 429 once the allowance is used, however the cooldown stands', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      for (let resend = 1; resend <= 4; resend++) {
        await forgetCooldown('new@example.com');
        await resendFor('new@example.com').expect(202);
      }
      expect(mailbox.sent).toHaveLength(5);

      await forgetCooldown('new@example.com');
      const refused = await resendFor('new@example.com').expect(429);
      expect(mailbox.sent).toHaveLength(5);
      // The hourly allowance resets within the hour, so the wait is longer than a cooldown
      expect(refused.body.errors.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.body.errors.retryAfterSeconds).toBeLessThanOrEqual(
        CACHE.AUTH.SETTINGS.OTP_SENDS_WINDOW,
      );
    });
  });

  describe('Verification AC-7: resend when nothing is waiting', () => {
    it('answers 404 and sends nothing for an address that has an account or never registered, with the same body for both', async () => {
      await registerUser(app, 'existing@example.com');
      mailbox.sent.length = 0;

      const existing = await resendFor('existing@example.com').expect(404);
      const unknown = await resendFor('unknown@example.com').expect(404);

      expect(existing.body.code).toBe('AUTH-009');
      // Nothing in the answer tells an account from an address nobody registered
      expect({ ...existing.body, traceId: null, timestamp: null }).toEqual({
        ...unknown.body,
        traceId: null,
        timestamp: null,
      });
      expect(mailbox.sent).toHaveLength(0);
    });

    it('answers 404 once the waiting registration has timed out, so the user knows to register again', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      await redisStore
        .getClient()
        .del(CACHE.AUTH.KEYS.PENDING_SIGNUP(sha256('new@example.com')));
      await forgetCooldown('new@example.com');
      mailbox.sent.length = 0;

      const res = await resendFor('new@example.com').expect(404);

      expect(res.body.code).toBe('AUTH-009');
      expect(mailbox.sent).toHaveLength(0);
    });

    it('does not use up the address allowance when there was nothing to send', async () => {
      await resendFor('nobody@example.com').expect(404);
      await resendFor('nobody@example.com').expect(404); // no 429: nothing was reserved

      await startRegistration(app, 'nobody@example.com').expect(202);
    });
  });

  describe('Verification AC-8: an address that already has an account', () => {
    it('is refused with 409 and no code is sent', async () => {
      await registerUser(app, 'existing@example.com');
      mailbox.sent.length = 0;

      await startRegistration(app, 'existing@example.com').expect(409);

      expect(mailbox.sent).toHaveLength(0);
    });
  });

  describe('Verification AC-9: registering again while one is waiting', () => {
    it('replaces the waiting registration (after the cooldown): the new password wins and the old code dies', async () => {
      await startRegistration(app, 'new@example.com', 'FirstPassword1!').expect(
        202,
      );
      const firstCode = codeSentTo('new@example.com');
      await forgetCooldown('new@example.com');

      await startRegistration(
        app,
        'new@example.com',
        'SecondPassword2!',
      ).expect(202);
      const secondCode = codeSentTo('new@example.com');

      if (firstCode !== secondCode) {
        await verifyEmail(
          app,
          'new@example.com',
          firstCode,
          'SecondPassword2!',
        ).expect(400);
      }
      await verifyEmail(
        app,
        'new@example.com',
        secondCode,
        'SecondPassword2!',
      ).expect(200);
      await loginUser(app, 'new@example.com', 'SecondPassword2!');
      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'new@example.com', password: 'FirstPassword1!' })
        .expect(401);
    });

    it('answers 429 in the cooldown and leaves the waiting registration, and its password, untouched', async () => {
      await startRegistration(app, 'new@example.com', 'FirstPassword1!').expect(
        202,
      );
      const code = codeSentTo('new@example.com');

      await startRegistration(
        app,
        'new@example.com',
        'SecondPassword2!',
      ).expect(429);

      await verifyEmail(app, 'new@example.com', code, 'FirstPassword1!').expect(
        200,
      );
      await loginUser(app, 'new@example.com', 'FirstPassword1!');
    });
  });

  describe('Verification AC-15: the password must match the registration', () => {
    it('a stranger who re-registered the address cannot take the account over: the owner confirming the new code with their own password is refused', async () => {
      // The owner registers; before confirming, somebody else re-registers the address with their own password
      await startRegistration(
        app,
        'new@example.com',
        'OwnersPassword1!',
      ).expect(202);
      await forgetCooldown('new@example.com');
      await startRegistration(
        app,
        'new@example.com',
        'StrangersPassword2!',
      ).expect(202);
      // The new code goes to the owner's mailbox
      const code = codeSentTo('new@example.com');

      const res = await verifyEmail(
        app,
        'new@example.com',
        code,
        'OwnersPassword1!',
      ).expect(400);

      expect(res.body.code).toBe('AUTH-011');
      expect(await prisma.user.count()).toBe(0);
    });

    it('a refused password leaves the code usable: the right password then works', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');

      await verifyEmail(
        app,
        'new@example.com',
        code,
        'NotThePassword-9',
      ).expect(400);

      await verifyEmail(app, 'new@example.com', code).expect(200);
    });

    it('a wrong code is refused with the generic error, not a password error, so the password is never judged first', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');

      const res = await verifyEmail(
        app,
        'new@example.com',
        wrongCodeFor(code),
        'NotThePassword-9',
      ).expect(400);

      expect(res.body.code).toBe('AUTH-008');
    });

    it('verify-email without a password is rejected', async () => {
      await request(app.getHttpServer())
        .post(`${API}/auth/verify-email`)
        .send({ email: 'new@example.com', code: '123456' })
        .expect(400);
    });
  });

  describe('Verification AC-10: the email provider fails', () => {
    it('still answers 202 and keeps the registration, so a later resend completes it', async () => {
      mailbox.failing = true;
      const res = await startRegistration(app, 'new@example.com').expect(202);
      expect(mailbox.sent).toHaveLength(0);
      // The send happens in the background (retried there); the user gets the normal cooldown
      expect(res.body.data.resendAvailableInSeconds).toBe(
        CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
      );
      await resendFor('new@example.com').expect(429);

      mailbox.failing = false;
      await forgetCooldown('new@example.com');
      await resendFor('new@example.com').expect(202);
      await verifyEmail(
        app,
        'new@example.com',
        codeSentTo('new@example.com'),
      ).expect(200);
    });
  });

  describe('Verification AC-11: the code is never stored in the clear', () => {
    it('appears nowhere in Redis, only a keyed hash does', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');

      const client = redisStore.getClient();
      const keys: string[] = await client.keys('*');
      const dump: string[] = [];
      for (const key of keys) {
        const type = await client.type(key);
        const value =
          type === 'hash' ? await client.hgetall(key) : await client.get(key);
        dump.push(key, JSON.stringify(value));
      }

      expect(dump.join('\n')).not.toContain(code);
      const otpKey = CACHE.AUTH.KEYS.OTP(
        'REGISTER_EMAIL',
        sha256('new@example.com'),
      );
      expect(await client.hget(otpKey, 'hash')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('Verification AC-12: two verifications at once', () => {
    it('create exactly one account: one request succeeds, the other is refused', async () => {
      await startRegistration(app, 'new@example.com').expect(202);
      const code = codeSentTo('new@example.com');

      const results = await Promise.all([
        verifyEmail(app, 'new@example.com', code),
        verifyEmail(app, 'new@example.com', code),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(await prisma.userCredential.count()).toBe(1);
      expect(await prisma.user.count()).toBe(1);
      for (const r of results) {
        expect(JSON.stringify(r.body)).not.toMatch(
          /unique constraint|provider|identifier/i,
        );
      }
    });
  });
});
