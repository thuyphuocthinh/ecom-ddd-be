import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  CACHE,
  EMAIL_SENDER,
} from './../src/core/index.js';
import type { EmailMessage } from './../src/core/index.js';

const API = '/api/v1';
const OLD = 'Sunny-Giraffe-42!';
const NEW = '7-purple-Giraffes-dance';
const EMAIL = 'jane.owner@example.com';

const mailbox = {
  sent: [] as EmailMessage[],
  failing: false,
  async send(message: EmailMessage): Promise<void> {
    if (this.failing) throw new Error('provider down');
    this.sent.push(message);
  },
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('Auth password (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const http = () => request(app.getHttpServer());

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
    app.useGlobalFilters(new AllExceptionsFilter(app.get(ClsService)));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix(API.replace('/', ''));
    await app.init();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redis.getClient().flushdb();
    mailbox.sent.length = 0;
    mailbox.failing = false;
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const lastMailTo = (email: string, subjectPart?: string) =>
    [...mailbox.sent]
      .reverse()
      .find(
        (m) =>
          m.to === email.toLowerCase() &&
          (!subjectPart || m.subject.includes(subjectPart)),
      );

  const resetCodeFor = (email: string): string => {
    const mail = lastMailTo(email, 'Mã đặt lại mật khẩu');
    if (!mail) throw new Error(`No reset code was emailed to ${email}`);
    return mail.text.match(/\b(\d{6})\b/)![1];
  };

  /** Registers (code by email, then confirm) and removes the session the confirmation opened */
  const createUser = async (email = EMAIL, password = OLD) => {
    await http()
      .post(`${API}/auth/register`)
      .send({ email, password })
      .expect(202);
    const code = [...mailbox.sent]
      .reverse()
      .find((m) => m.to === email)!
      .text.match(/\b(\d{6})\b/)![1];
    await http()
      .post(`${API}/auth/verify-email`)
      .send({ email, code, password })
      .expect(200);
    await prisma.session.deleteMany({});
    mailbox.sent.length = 0;
  };

  const login = (email = EMAIL, password = OLD, device = 'laptop') =>
    http()
      .post(`${API}/auth/login`)
      .set('User-Agent', device)
      .send({ email, password });

  const loginOk = async (device: string, password = OLD) =>
    (await login(EMAIL, password, device).expect(200)).body.data as {
      accessToken: string;
      refreshToken: string;
    };

  const forgot = (email = EMAIL) =>
    http().post(`${API}/auth/forgot-password`).send({ email });

  const reset = (code: string, newPassword = NEW, email = EMAIL) =>
    http()
      .post(`${API}/auth/reset-password`)
      .send({ email, code, newPassword });

  const change = (
    token: string,
    currentPassword: string,
    newPassword: string,
  ) =>
    http()
      .post(`${API}/auth/change-password`)
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword, newPassword });

  const me = (token: string) =>
    http().get(`${API}/users/me`).set('Authorization', `Bearer ${token}`);

  const refresh = (refreshToken: string) =>
    http().post(`${API}/auth/refresh`).send({ refreshToken });

  // ── forgot-password ────────────────────────────────────────────────────────

  describe('AC-1: forgot-password does not reveal which emails have an account', () => {
    it('answers an address with an account and one without in exactly the same way', async () => {
      await createUser();

      const known = await forgot(EMAIL).expect(202);
      const unknown = await forgot('nobody@example.com').expect(202);

      expect(unknown.body.data).toEqual(known.body.data);
      expect(known.body.data).toEqual({
        resendAvailableInSeconds: CACHE.AUTH.SETTINGS.OTP_RESEND_COOLDOWN,
      });
    });

    it('answers 429 the same way for both when asked again too soon, with the wait time (within a second)', async () => {
      await createUser();
      await forgot(EMAIL).expect(202);
      await forgot('nobody@example.com').expect(202);

      const known = await forgot(EMAIL).expect(429);
      const unknown = await forgot('nobody@example.com').expect(429);

      expect(known.body.code).toBe(unknown.body.code);
      expect(
        Math.abs(
          known.body.errors.retryAfterSeconds -
            unknown.body.errors.retryAfterSeconds,
        ),
      ).toBeLessThanOrEqual(1);
      expect(known.headers['retry-after']).toBeDefined();
      expect(unknown.headers['retry-after']).toBeDefined();
    });
  });

  describe('AC-2: only an address with an account gets a code', () => {
    it('emails a reset code to an address with an account, with the code kept out of the subject', async () => {
      await createUser();

      await forgot(EMAIL).expect(202);

      const mail = lastMailTo(EMAIL, 'Mã đặt lại mật khẩu')!;
      expect(mail).toBeDefined();
      expect(mail.subject).not.toMatch(/\d{6}/);
      expect(resetCodeFor(EMAIL)).toMatch(/^\d{6}$/);
    });

    it('sends nothing and stores no code for an address with no account', async () => {
      await forgot('nobody@example.com').expect(202);

      expect(mailbox.sent).toHaveLength(0);
      expect(
        await redis
          .getClient()
          .exists(
            CACHE.AUTH.KEYS.OTP('RESET_PASSWORD', sha256('nobody@example.com')),
          ),
      ).toBe(0);
    });
  });

  // ── reset-password ─────────────────────────────────────────────────────────

  describe('AC-3: reset-password', () => {
    it('sets the new password, closes every session, uses the code up, does not log in, and notifies the owner', async () => {
      await createUser();
      const laptop = await loginOk('laptop');
      const phone = await loginOk('phone');
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);

      const res = await reset(code).expect(204);

      expect(res.body).toEqual({});
      // the new password works, the old one does not
      await login(EMAIL, OLD).expect(401);
      await loginOk('laptop-again', NEW);
      // every old session is dead: access token at once, refresh token too
      for (const session of [laptop, phone]) {
        await me(session.accessToken).expect(401);
        await refresh(session.refreshToken).expect(401);
      }
      // closed, with the reason recorded
      const closed = await prisma.session.findMany({
        where: { revokedReason: 'PASSWORD_RESET' },
      });
      expect(closed).toHaveLength(2);
      // the code cannot be used again
      await reset(code).expect(400);
      // the owner is told
      expect(lastMailTo(EMAIL, 'vừa được thay đổi')).toBeDefined();
    });

    it('does not create a session: the person has to log in', async () => {
      await createUser();
      await forgot().expect(202);

      await reset(resetCodeFor(EMAIL)).expect(204);

      expect(await prisma.session.count()).toBe(0);
    });
  });

  describe('AC-4: a bad code', () => {
    it('answers a wrong code and an address with no account with the same error', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);
      const wrong = code === '000000' ? '000001' : '000000';

      const wrongCode = await reset(wrong).expect(400);
      const unknown = await reset(wrong, NEW, 'nobody@example.com').expect(400);

      expect(wrongCode.body.code).toBe('AUTH-008');
      expect(unknown.body.code).toBe('AUTH-008');
      expect(unknown.body.message).toBe(wrongCode.body.message);
    });

    it('locks a client out after 3 wrong tries (tighter than registration), even for the right code', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);
      const wrong = code === '000000' ? '000001' : '000000';

      for (let i = 0; i < 3; i++) await reset(wrong).expect(400);

      await reset(code).expect(400);
      // the password did not change
      await loginOk('laptop');
    });

    it('three wrong tries from one client lock that client out but leave the code alive for everybody else (the total counter stays far below the destroy limit)', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);
      const wrong = code === '000000' ? '000001' : '000000';
      const key = CACHE.AUTH.KEYS.OTP('RESET_PASSWORD', sha256(EMAIL));

      for (let i = 0; i < 3; i++) await reset(wrong).expect(400);

      expect(await redis.getClient().exists(key)).toBe(1);
      expect(await redis.getClient().hget(key, 'attempts')).toBe('3');
      // a client that has not used up its tries (here: the same client once its own counter is cleared)
      // still gets in with the right code
      const fields = Object.keys(await redis.getClient().hgetall(key)).filter(
        (field) => field.startsWith('c:'),
      );
      await redis.getClient().hdel(key, ...fields);
      await reset(code).expect(204);
    });

    it('ten wrong tries in total destroy the code, so the right code no longer works (AC-4)', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);
      const key = CACHE.AUTH.KEYS.OTP('RESET_PASSWORD', sha256(EMAIL));
      await redis
        .getClient()
        .hset(
          key,
          'attempts',
          CACHE.AUTH.SETTINGS.OTP_LIMITS.RESET_PASSWORD.totalAttempts,
        );

      await reset(code === '000000' ? '000001' : '000000').expect(400);

      expect(await redis.getClient().exists(key)).toBe(0);
      await reset(code).expect(400);
    });
  });

  describe('AC-5: an easy new password', () => {
    it('is refused with the reason before the code is touched, and the code still works afterwards', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);

      const res = await reset(code, 'password123').expect(400);

      expect(res.body.code).toBe('AUTH-010');
      expect(res.body.errors).toEqual({ reason: 'COMMON' });
      // nothing was closed, and the code was not used
      await loginOk('laptop');
      await reset(code).expect(204);
    });
  });

  describe('AC-6: codes for different purposes do not mix', () => {
    it('a registration code does not reset the password of an account that exists, while the real reset code still works', async () => {
      await createUser();
      await forgot().expect(202);
      const resetCode = resetCodeFor(EMAIL);
      // A valid REGISTER_EMAIL code for the same address, made the way registration makes it
      const { OtpService } =
        await import('./../src/modules/auth/application/services/otp.service.js');
      const registerCode = await app
        .get(OtpService)
        .issue('REGISTER_EMAIL', EMAIL);

      await reset(registerCode).expect(400);
      expect(
        await redis
          .getClient()
          .exists(CACHE.AUTH.KEYS.OTP('REGISTER_EMAIL', sha256(EMAIL))),
      ).toBe(1);
      // the reset code was not disturbed by the other purpose
      await reset(resetCode).expect(204);
    });
  });

  describe('AC-4: the hourly allowance of reset codes', () => {
    it('allows 3 codes an hour for one address, then answers 429 even once the cooldown has passed', async () => {
      await createUser();
      const cooldown = CACHE.AUTH.KEYS.OTP_COOLDOWN(
        'RESET_PASSWORD',
        sha256(EMAIL),
      );

      for (let i = 0; i < 3; i++) {
        await forgot().expect(202);
        await redis.getClient().del(cooldown);
      }

      await forgot().expect(429);
    });
  });

  // ── change-password ────────────────────────────────────────────────────────

  describe('AC-7: change-password', () => {
    it('logs the other devices out at once, keeps this one, and cancels a waiting reset code', async () => {
      await createUser();
      const laptop = await loginOk('laptop');
      const phone = await loginOk('phone');
      await forgot().expect(202);
      const waitingCode = resetCodeFor(EMAIL);

      await change(laptop.accessToken, OLD, NEW).expect(204);

      // the phone is out: access token refused at once, refresh refused
      await me(phone.accessToken).expect(401);
      await refresh(phone.refreshToken).expect(401);
      // the laptop carries on, including refreshing
      await me(laptop.accessToken).expect(200);
      await refresh(laptop.refreshToken).expect(200);
      // new password in, old out
      await login(EMAIL, OLD).expect(401);
      await loginOk('tablet', NEW);
      // the reset code that was still in the mailbox no longer works
      await reset(waitingCode, '9-orange-Pandas-fly').expect(400);
      // recorded and notified
      expect(
        await prisma.session.count({
          where: { revokedReason: 'PASSWORD_CHANGED' },
        }),
      ).toBe(1);
      expect(lastMailTo(EMAIL, 'vừa được thay đổi')).toBeDefined();
    });
  });

  describe('AC-8: a wrong current password', () => {
    it('is refused with AUTH-012 and changes nothing', async () => {
      await createUser();
      const laptop = await loginOk('laptop');
      const phone = await loginOk('phone');

      const res = await change(
        laptop.accessToken,
        'Wrong-Giraffe-1!',
        NEW,
      ).expect(400);

      expect(res.body.code).toBe('AUTH-012');
      await me(phone.accessToken).expect(200);
      await loginOk('tablet', OLD);
    });

    it('allows only 5 attempts per 15 minutes for one user, whatever the outcome', async () => {
      await createUser();
      const laptop = await loginOk('laptop');

      for (let i = 0; i < 5; i++) {
        await change(laptop.accessToken, 'Wrong-Giraffe-1!', NEW).expect(400);
      }

      await change(laptop.accessToken, OLD, NEW).expect(429);
    });
  });

  describe('AC-9: the new password when changing', () => {
    it('must differ from the current one', async () => {
      await createUser();
      const laptop = await loginOk('laptop');

      const res = await change(laptop.accessToken, OLD, OLD).expect(400);

      expect(res.body.code).toBe('AUTH-010');
      expect(res.body.errors).toEqual({ reason: 'SAME_AS_CURRENT' });
    });

    it('must not be easy to guess', async () => {
      await createUser();
      const laptop = await loginOk('laptop');

      const res = await change(laptop.accessToken, OLD, 'qwertyuiop').expect(
        400,
      );

      expect(res.body.errors.reason).toBe('COMMON');
    });
  });

  describe('AC-10: a session that was closed cannot change the password either', () => {
    it('answers 401 for the access token of a session logged out already', async () => {
      await createUser();
      const laptop = await loginOk('laptop');
      await http()
        .post(`${API}/auth/logout`)
        .set('Authorization', `Bearer ${laptop.accessToken}`)
        .expect(204);

      await change(laptop.accessToken, OLD, NEW).expect(401);
    });
  });

  describe('AC-10: change-password needs a login', () => {
    it('answers 401 without an access token, and with a bad one', async () => {
      await http()
        .post(`${API}/auth/change-password`)
        .send({ currentPassword: OLD, newPassword: NEW })
        .expect(401);
      await change('not-a-token', OLD, NEW).expect(401);
    });
  });

  // ── failures and races ─────────────────────────────────────────────────────

  describe('AC-12: when the email provider fails', () => {
    it('reset-password and change-password still succeed; the notice is only a notice', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);
      mailbox.failing = true;

      await reset(code).expect(204);
      const session = await loginOk('laptop', NEW);
      await change(session.accessToken, NEW, '9-orange-Pandas-fly').expect(204);

      await login(EMAIL, '9-orange-Pandas-fly').expect(200);
    });
  });

  describe('AC-13: two resets with the same code at the same time', () => {
    it('lets exactly one win', async () => {
      await createUser();
      await forgot().expect(202);
      const code = resetCodeFor(EMAIL);

      const results = await Promise.all([reset(code), reset(code)]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
      await loginOk('laptop', NEW);
    });
  });
});
