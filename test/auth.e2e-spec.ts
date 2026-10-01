import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  CACHE,
} from './../src/core/index.js';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { JwtService } from '@nestjs/jwt';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const API = '/api/v1';

/** Register a new user and return { email, password } */
async function registerUser(
  app: INestApplication,
  email = `test-${Date.now()}@example.com`,
  password = 'Password123!',
): Promise<{ email: string; password: string }> {
  await request(app.getHttpServer())
    .post(`${API}/auth/register`)
    .send({ email, password })
    .expect(201);
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
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
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
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-1: Register — success
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-1: POST /auth/register — success', () => {
    it('returns 201 Created and the new userId', async () => {
      const res = await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ email: 'new@example.com', password: 'Password123!' })
        .expect(201);

      expect(res.body).toMatchObject({ statusCode: 201 });
      expect(typeof res.body.data.userId).toBe('string');
      expect(res.body.data.userId.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AC-2: Register — duplicate email
  // ───────────────────────────────────────────────────────────────────────────
  describe('AC-2: POST /auth/register — duplicate email → 409', () => {
    it('returns 409 Conflict with a generic message (no email in message body)', async () => {
      await registerUser(app, 'dup@example.com');

      const res = await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ email: 'dup@example.com', password: 'Password123!' })
        .expect(409);

      // Error message MUST NOT reveal the exact email
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('dup@example.com');
    });
  });

  describe('AC-2b: email is case-insensitive', () => {
    it('treats A@x.com and a@x.com as the same account (409), and login works with either casing', async () => {
      await registerUser(app, 'Mixed.Case@Example.com');

      await request(app.getHttpServer())
        .post(`${API}/auth/register`)
        .send({ email: 'mixed.case@example.com', password: 'Password123!' })
        .expect(409);

      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: '  MIXED.CASE@example.com ', password: 'Password123!' })
        .expect(200);
    });
  });

  describe('AC-2c: concurrent registration of the same email', () => {
    it('yields exactly one 201 and one 409 — never a 500, never a leaked DB error', async () => {
      const send = () =>
        request(app.getHttpServer())
          .post(`${API}/auth/register`)
          .send({ email: 'race@example.com', password: 'Password123!' });

      const results = await Promise.all([send(), send()]);
      const statuses = results.map((r) => r.status).sort();

      expect(statuses).toEqual([201, 409]);
      for (const r of results) {
        expect(JSON.stringify(r.body)).not.toMatch(
          /unique constraint|provider|identifier/i,
        );
      }
    });
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
          .send({ email: `nouser${i}@example.com`, password: 'pass' });
        // Responses 1-5 should NOT be 429
        expect(res.status).not.toBe(429);
      }

      // 6th attempt must be blocked
      const blocked = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: 'nouser6@example.com', password: 'pass' })
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
});
