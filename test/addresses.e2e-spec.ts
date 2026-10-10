import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  EMAIL_SENDER,
} from './../src/core/index.js';
import type { EmailMessage } from './../src/core/index.js';

const API = '/api/v1';
const BASE = `${API}/users/me/addresses`;
const PASSWORD = 'Sunny-Giraffe-42!';

const BA_DINH = '00004';
const BA_VI = '00005';
const HAI_CHAU = '20000';

const mailbox = {
  sent: [] as EmailMessage[],
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  },
};

describe('Addresses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
  const body = (overrides: Record<string, unknown> = {}) => ({
    recipientName: 'Nguyễn Văn A',
    phone: '0912345678',
    wardCode: BA_DINH,
    street: '12 Bạch Đằng',
    ...overrides,
  });
  const add = (token: string, overrides: Record<string, unknown> = {}) =>
    http().post(BASE).set(authed(token)).send(body(overrides));
  const list = (token: string) => http().get(BASE).set(authed(token));

  const registerWithPassword = async (email: string) => {
    await http()
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD })
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
    return res.body.data.accessToken as string;
  };

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

  const clear = async () => {
    await prisma.address.deleteMany();
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await prisma.ward.deleteMany();
    await prisma.province.deleteMany();
  };

  beforeEach(async () => {
    await clear();
    await redis.getClient().flushdb();
    mailbox.sent.length = 0;
    await prisma.province.createMany({
      data: [
        { code: '01', name: 'Hà Nội', type: 'CITY' },
        { code: '48', name: 'Đà Nẵng', type: 'CITY' },
      ],
    });
    await prisma.ward.createMany({
      data: [
        { code: BA_DINH, provinceCode: '01', name: 'Ba Đình', type: 'WARD' },
        { code: BA_VI, provinceCode: '01', name: 'Ba Vì', type: 'COMMUNE' },
        { code: HAI_CHAU, provinceCode: '48', name: 'Hải Châu', type: 'WARD' },
      ],
    });
  });

  afterAll(async () => {
    await clear();
    await app.close();
  });

  it('refuses every endpoint without a token (AC-11)', async () => {
    await http().get(BASE).expect(401);
    await http().post(BASE).send(body()).expect(401);
    await http().patch(`${BASE}/x`).send({ street: 'x' }).expect(401);
    await http().put(`${BASE}/x/default`).expect(401);
    await http().delete(`${BASE}/x`).expect(401);
  });

  it('works end to end: pick a ward from the catalog, save, list, change, set default, delete (AC-1 to AC-7)', async () => {
    const token = await registerWithPassword('jane@example.com');

    // the form picks the province, then a ward of it
    const wards = await http()
      .get(`${API}/locations/provinces/01/wards`)
      .expect(200);
    const ward = wards.body.data[0];
    expect(ward.fullName).toBe('Phường Ba Đình');

    const first = await add(token, {
      wardCode: ward.code,
      label: 'Nhà',
    }).expect(201);
    expect(first.body.data).toMatchObject({
      recipientName: 'Nguyễn Văn A',
      phone: '0912345678',
      provinceCode: '01',
      provinceName: 'Thành phố Hà Nội',
      wardCode: BA_DINH,
      wardName: 'Phường Ba Đình',
      street: '12 Bạch Đằng',
      label: 'Nhà',
      isDefault: true,
    });
    expect(Object.keys(first.body.data).sort()).toEqual([
      'createdAt',
      'id',
      'isDefault',
      'label',
      'phone',
      'provinceCode',
      'provinceName',
      'recipientName',
      'street',
      'updatedAt',
      'wardCode',
      'wardName',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await add(token, {
      wardCode: HAI_CHAU,
      phone: '+84 987.654.321',
    }).expect(201);
    expect(second.body.data).toMatchObject({
      isDefault: false,
      provinceName: 'Thành phố Đà Nẵng',
      phone: '0987654321',
    });

    const mine = await list(token).expect(200);
    expect(mine.body.data.map((a: { id: string }) => a.id)).toEqual([
      first.body.data.id,
      second.body.data.id,
    ]);

    const changed = await http()
      .patch(`${BASE}/${second.body.data.id}`)
      .set(authed(token))
      .send({ street: '5 Lê Duẩn', label: null })
      .expect(200);
    expect(changed.body.data).toMatchObject({
      street: '5 Lê Duẩn',
      label: null,
      isDefault: false,
    });

    const made = await http()
      .put(`${BASE}/${second.body.data.id}/default`)
      .set(authed(token))
      .expect(200);
    expect(made.body.data.isDefault).toBe(true);
    const afterDefault = await list(token).expect(200);
    expect(
      afterDefault.body.data.filter((a: { isDefault: boolean }) => a.isDefault),
    ).toHaveLength(1);
    expect(afterDefault.body.data[0].id).toBe(second.body.data.id);

    await http()
      .delete(`${BASE}/${second.body.data.id}`)
      .set(authed(token))
      .expect(204);
    const afterDelete = await list(token).expect(200);
    expect(afterDelete.body.data).toHaveLength(1);
    expect(afterDelete.body.data[0]).toMatchObject({
      id: first.body.data.id,
      isDefault: true, // the remaining one took over
    });
  });

  it('answers an empty list for a user without addresses (AC-1)', async () => {
    const token = await registerWithPassword('jane@example.com');

    const res = await list(token).expect(200);

    expect(res.body.data).toEqual([]);
  });

  describe('wrong requests (AC-3, AC-5)', () => {
    it('answers 400 for bad data, and ADDR-003 with the field when the data itself is wrong', async () => {
      const token = await registerWithPassword('jane@example.com');

      const badPhone = await add(token, { phone: '123' }).expect(400);
      expect(badPhone.body.code).toBe('ADDR-003');
      expect(badPhone.body.errors).toMatchObject({ field: 'phone' });

      const noWard = await add(token, { wardCode: '99999' }).expect(400);
      expect(noWard.body.errors).toMatchObject({
        field: 'wardCode',
        reason: 'WARD_NOT_FOUND',
      });

      const missing = await http()
        .post(BASE)
        .set(authed(token))
        .send({ recipientName: 'A' })
        .expect(400); // not a text, missing fields: refused before reaching the rules
      expect(missing.body.code).toBeDefined();
      await add(token, { street: 42 }).expect(400);
      await add(token, { isDefault: 'yes' }).expect(400);

      expect((await list(token)).body.data).toEqual([]);
    });

    it('refuses fields that are not allowed: the province cannot be sent, nor the default flag on an update', async () => {
      const token = await registerWithPassword('jane@example.com');
      const created = await add(token).expect(201);
      const id = created.body.data.id;

      await add(token, { provinceCode: '48' }).expect(400);
      await add(token, { userId: 'someone' }).expect(400);
      await http()
        .patch(`${BASE}/${id}`)
        .set(authed(token))
        .send({ isDefault: false })
        .expect(400);
      await http()
        .patch(`${BASE}/${id}`)
        .set(authed(token))
        .send({ userId: 'x' })
        .expect(400);
      await http()
        .patch(`${BASE}/${id}`)
        .set(authed(token))
        .send({ provinceCode: '48' })
        .expect(400);

      const stored = (await list(token)).body.data;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ provinceCode: '01', isDefault: true });
    });

    it('answers 400 ADDR-003 for an update with nothing in it', async () => {
      const token = await registerWithPassword('jane@example.com');
      const created = await add(token).expect(201);

      const res = await http()
        .patch(`${BASE}/${created.body.data.id}`)
        .set(authed(token))
        .send({})
        .expect(400);

      expect(res.body.code).toBe('ADDR-003');
    });
  });

  it('refuses the eleventh address with 409 ADDR-002 (AC-4)', async () => {
    const token = await registerWithPassword('jane@example.com');
    for (let i = 0; i < 10; i++) await add(token).expect(201);

    const res = await add(token).expect(409);

    expect(res.body.code).toBe('ADDR-002');
    expect((await list(token)).body.data).toHaveLength(10);
  });

  it('does not let one user see or change the addresses of another (AC-8)', async () => {
    const jane = await registerWithPassword('jane@example.com');
    const john = await registerWithPassword('john@example.com');
    const janes = (await add(jane, { label: 'Nhà' }).expect(201)).body.data;
    await add(john).expect(201);

    // Each call is made when its turn comes (a request is bound to the server when it is built)
    const attempts = [
      () =>
        http()
          .patch(`${BASE}/${janes.id}`)
          .set(authed(john))
          .send({ street: 'hacked' }),
      () => http().put(`${BASE}/${janes.id}/default`).set(authed(john)),
      () => http().delete(`${BASE}/${janes.id}`).set(authed(john)),
      () =>
        http()
          .patch(`${BASE}/no-such-id`)
          .set(authed(john))
          .send({ street: 'x' }),
      () => http().put(`${BASE}/no-such-id/default`).set(authed(john)),
      () => http().delete(`${BASE}/no-such-id`).set(authed(john)),
    ];
    for (const attempt of attempts) {
      const res = await attempt().expect(404);
      expect(res.body.code).toBe('ADDR-001');
    }

    const johnsList = (await list(john).expect(200)).body.data;
    expect(johnsList).toHaveLength(1);
    expect(johnsList.every((a: { id: string }) => a.id !== janes.id)).toBe(
      true,
    );
    const janesList = (await list(jane).expect(200)).body.data;
    expect(janesList).toHaveLength(1);
    expect(janesList[0]).toMatchObject({
      street: '12 Bạch Đằng',
      label: 'Nhà',
    });
  });

  it('keeps one default when a user sends several requests at the same time (AC-9)', async () => {
    const token = await registerWithPassword('jane@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await add(token).expect(201)).body.data.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const results = await Promise.all(
      [...ids, ...ids].map((id) =>
        http().put(`${BASE}/${id}/default`).set(authed(token)),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    const mine = (await list(token)).body.data;
    expect(
      mine.filter((a: { isDefault: boolean }) => a.isDefault),
    ).toHaveLength(1);
  });

  it('allows 30 writes in 15 minutes on a route and then answers 429 (AC-11)', async () => {
    const token = await registerWithPassword('jane@example.com');
    const created = await add(token).expect(201);
    const url = `${BASE}/${created.body.data.id}/default`;

    for (let i = 0; i < 30; i++) {
      await http().put(url).set(authed(token)).expect(200);
    }
    await http().put(url).set(authed(token)).expect(429);
    // reading is not counted that way
    await list(token).expect(200);
  });
});
