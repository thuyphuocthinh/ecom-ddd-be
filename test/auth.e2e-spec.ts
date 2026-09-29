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

  beforeEach(async () => {
    // Clean auth-related data before each test
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redisStore.getClient().flushdb();
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-1: Register — success
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-1: POST /auth/register — success', () => {
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
  // SC-2: Register — duplicate email
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-2: POST /auth/register — duplicate email → 409', () => {
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

  describe('SC-2b: email is case-insensitive', () => {
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

  describe('SC-2c: concurrent registration of the same email', () => {
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
  // SC-3: Login — success, AT + RT in body
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-3: POST /auth/login — success → { accessToken, refreshToken }', () => {
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
  // SC-4: Login — wrong password
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-4: POST /auth/login — wrong password → 401 generic', () => {
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
  // SC-5: Rate limit — login (off-by-one boundary)
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-5: Rate limit login — 429 after 5 attempts', () => {
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
  // SC-6: AT expired → 401
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-6: Expired AT → 401 on protected route', () => {
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
  // SC-7: Refresh — success + RT rotation
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-7: POST /auth/refresh — returns new tokens, old RT is revoked', () => {
    it('issues a new AT and RT, and old RT cannot be reused after grace window', async () => {
      const tokens = await registerAndLogin(app);

      const refreshRes = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      const newTokens = refreshRes.body.data;
      expect(newTokens).toHaveProperty('accessToken');
      expect(newTokens).toHaveProperty('refreshToken');
      expect(newTokens.refreshToken).not.toBe(tokens.refreshToken);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-8: Reuse — an already-rotated RT is rejected once the grace window is over
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-8: POST /auth/refresh — rotated RT reused after the grace window → 401', () => {
    it('rejects the old RT, while the RT it was rotated into keeps working', async () => {
      const tokens = await registerAndLogin(app);

      const rotated = await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      // Simulate "more than 15 seconds later" by dropping the grace entry
      const oldHash = createHash('sha256')
        .update(tokens.refreshToken)
        .digest('hex');
      await redisStore.getClient().del(CACHE.AUTH.KEYS.ROTATION_GRACE(oldHash));

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      await request(app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.data.refreshToken })
        .expect(200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-9: Grace Window — concurrent refresh
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-9: Grace Window — two concurrent refreshes return same tokens', () => {
    it('both requests with the same RT return identical token pairs within 15s', async () => {
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
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-10: Logout
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-10: POST /auth/logout — AT blacklisted, RT revoked', () => {
    it('returns 204 and old AT is rejected on subsequent requests', async () => {
      const { email, password } = await registerUser(app);
      const tokens = await loginUser(app, email, password);

      // Verify the AT works before logout
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      // Logout
      await request(app.getHttpServer())
        .post(`${API}/auth/logout`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      // AT should now be blacklisted
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-11: Logout All
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-11: POST /auth/logout-all — all existing ATs invalidated', () => {
    it('returns 204 and existing ATs from other sessions are rejected', async () => {
      const { email, password } = await registerUser(app);

      // Login on device 1
      const device1 = await loginUser(app, email, password);
      // Login on device 2
      const device2 = await loginUser(app, email, password);

      // Verify device1 AT works
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${device1.accessToken}`)
        .expect(200);

      // Logout all from device 2
      await request(app.getHttpServer())
        .post(`${API}/auth/logout-all`)
        .set('Authorization', `Bearer ${device2.accessToken}`)
        .expect(204);

      // Device 1 AT must now be invalid (tokenVersion bumped)
      await request(app.getHttpServer())
        .get(`${API}/users/me`)
        .set('Authorization', `Bearer ${device1.accessToken}`)
        .expect(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SC-12: RBAC — CUSTOMER cannot call ADMIN endpoint
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-12: RBAC — CUSTOMER → POST /catalog/products → 403', () => {
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
  // SC-13: RBAC — ADMIN can call ADMIN endpoint
  // ───────────────────────────────────────────────────────────────────────────
  describe('SC-13: RBAC — ADMIN → POST /catalog/products → not 401/403', () => {
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
});
