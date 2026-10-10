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
const CART = `${API}/cart`;
const PASSWORD = 'Sunny-Giraffe-42!';

const mailbox = {
  sent: [] as EmailMessage[],
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  },
};

describe('Cart (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
  const view = (token: string) => http().get(CART).set(authed(token));
  const add = (token: string, skuId: string, quantity: unknown = 1) =>
    http().post(`${CART}/items`).set(authed(token)).send({ skuId, quantity });
  const setQuantity = (token: string, skuId: string, quantity: unknown) =>
    http().put(`${CART}/items/${skuId}`).set(authed(token)).send({ quantity });

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
    // also clears the rate limit counters, so signing people up does not run into them
    await redis.getClient().flushdb();
    await prisma.reservation.deleteMany();
    await prisma.skuStock.deleteMany();
    await prisma.sku.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
  };

  beforeEach(async () => {
    await clear();
    mailbox.sent.length = 0;
    await prisma.category.create({
      data: { id: 'e2e_cat', name: 'C', path: '/e2e_cat/' },
    });
    await prisma.product.createMany({
      data: [
        {
          id: 'E_ON',
          categoryId: 'e2e_cat',
          name: 'AirPods',
          status: 'PUBLISHED',
        },
        {
          id: 'E_DRAFT',
          categoryId: 'e2e_cat',
          name: 'Hidden',
          status: 'DRAFT',
        },
      ],
    });
    await prisma.sku.createMany({
      data: [
        {
          id: 'E_S1',
          productId: 'E_ON',
          price: 3990000,
          attributes: { color: 'White' },
          skuCode: 'E-S1',
        },
        {
          id: 'E_S2',
          productId: 'E_ON',
          price: 500000,
          attributes: { color: 'Black' },
          skuCode: 'E-S2',
        },
        {
          id: 'E_S3',
          productId: 'E_DRAFT',
          price: 100,
          attributes: { color: 'Red' },
          skuCode: 'E-S3',
        },
      ],
    });
    await prisma.skuStock.createMany({
      data: [
        { skuId: 'E_S1', onHand: 10 },
        { skuId: 'E_S2', onHand: 1 },
        { skuId: 'E_S3', onHand: 10 },
      ],
    });
  });

  afterAll(async () => {
    await clear();
    await app.close();
  });

  it('refuses every endpoint without a token (AC-14)', async () => {
    await http().get(CART).expect(401);
    await http()
      .post(`${CART}/items`)
      .send({ skuId: 'x', quantity: 1 })
      .expect(401);
    await http().put(`${CART}/items/x`).send({ quantity: 1 }).expect(401);
    await http().delete(`${CART}/items/x`).expect(401);
    await http().delete(CART).expect(401);
  });

  it('works end to end: empty, add, merge, view with flags, set, remove, clear (AC-1 to AC-8)', async () => {
    const token = await registerWithPassword('jane@example.com');

    // AC-1: nothing yet
    const empty = await view(token).expect(200);
    expect(empty.body.data).toEqual({
      items: [],
      subtotal: 0,
      lineCount: 0,
      quantityCount: 0,
    });

    // AC-2: a new item, at the price now
    const first = await add(token, 'E_S1', 2).expect(201);
    expect(first.body.data).toEqual({
      skuId: 'E_S1',
      quantity: 2,
      addedPrice: 3990000,
    });
    // AC-3: the same item again adds up (one line, not two)
    const again = await add(token, 'E_S1', 3).expect(201);
    expect(again.body.data.quantity).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await add(token, 'E_S2', 3).expect(201); // only 1 in stock

    // the price of E_S1 changes after it was put in the cart
    await prisma.sku.update({
      where: { id: 'E_S1' },
      data: { price: 4990000 },
    });

    const cart = (await view(token).expect(200)).body.data;
    expect(cart.items.map((i: { skuId: string }) => i.skuId)).toEqual([
      'E_S2',
      'E_S1',
    ]); // newest first
    const [second, firstLine] = cart.items;
    expect(second).toMatchObject({
      productName: 'AirPods',
      attributes: { color: 'Black' },
      quantity: 3,
      price: 500000,
      addedPrice: 500000,
      available: 1,
      flags: ['notEnoughStock'],
    });
    expect(firstLine).toMatchObject({
      quantity: 5,
      price: 4990000,
      addedPrice: 3990000,
      available: 10,
      flags: ['priceChanged'],
    });
    expect(cart.subtotal).toBe(5 * 4990000); // only E_S1 can be ordered as it is
    expect(cart.lineCount).toBe(2);
    expect(cart.quantityCount).toBe(8);

    // AC-6: set the quantity (twice gives the same answer); the price seen is renewed
    const set = await setQuantity(token, 'E_S1', 2).expect(200);
    const setAgain = await setQuantity(token, 'E_S1', 2).expect(200);
    expect(set.body.data).toEqual({
      skuId: 'E_S1',
      quantity: 2,
      addedPrice: 4990000,
    });
    expect(setAgain.body.data).toEqual(set.body.data);
    const afterSet = (await view(token).expect(200)).body.data;
    expect(
      afterSet.items.find((i: { skuId: string }) => i.skuId === 'E_S1').flags,
    ).toEqual([]);

    // AC-7: remove one (twice is fine), then clear
    await http().delete(`${CART}/items/E_S2`).set(authed(token)).expect(204);
    await http().delete(`${CART}/items/E_S2`).set(authed(token)).expect(204);
    expect((await view(token)).body.data.lineCount).toBe(1);
    await http().delete(CART).set(authed(token)).expect(204);
    await http().delete(CART).set(authed(token)).expect(204);
    expect((await view(token)).body.data.items).toEqual([]);
  });

  it('shows what is no longer sold without hiding the rest (AC-8)', async () => {
    const token = await registerWithPassword('jane@example.com');
    await add(token, 'E_S1').expect(201);
    await add(token, 'E_S2').expect(201);
    await prisma.product.update({
      where: { id: 'E_ON' },
      data: { status: 'DRAFT' },
    });

    const cart = (await view(token).expect(200)).body.data;

    expect(cart.items).toHaveLength(2);
    for (const item of cart.items) {
      expect(item).toMatchObject({
        price: null,
        available: null,
        flags: ['unpublished'],
      });
    }
    expect(cart.subtotal).toBe(0);
  });

  describe('what is refused (AC-2, AC-4, AC-5, AC-6)', () => {
    it('does not let an item that is not on sale in, with 404 CART-003', async () => {
      const token = await registerWithPassword('jane@example.com');

      const draft = await add(token, 'E_S3').expect(404);
      const missing = await add(token, 'NO-SUCH-SKU').expect(404);

      expect(draft.body.code).toBe('CART-003');
      expect(missing.body.code).toBe('CART-003');
      expect((await view(token)).body.data.items).toEqual([]);
    });

    it('answers 409 CART-002 over 99 of one item and keeps the old quantity', async () => {
      const token = await registerWithPassword('jane@example.com');
      await add(token, 'E_S1', 95).expect(201);

      const over = await add(token, 'E_S1', 10).expect(409);
      const overSet = await setQuantity(token, 'E_S1', 100).expect(409);

      expect(over.body.code).toBe('CART-002');
      expect(overSet.body.code).toBe('CART-002');
      expect((await view(token)).body.data.items[0].quantity).toBe(95);
    });

    it('answers 409 CART-001 for the 51st different item', async () => {
      const token = await registerWithPassword('jane@example.com');
      await prisma.sku.createMany({
        data: Array.from({ length: 51 }, (_, i) => ({
          id: `E_M${i}`,
          productId: 'E_ON',
          price: 1000,
          attributes: { n: String(i) },
          skuCode: `E-M${i}`,
        })),
      });
      for (let i = 0; i < 50; i++) await add(token, `E_M${i}`).expect(201);

      const res = await add(token, 'E_M50').expect(409);

      expect(res.body.code).toBe('CART-001');
      expect((await view(token)).body.data.lineCount).toBe(50);
      await add(token, 'E_M3', 2).expect(201); // an item already there still takes more
    });

    it('answers 404 CART-004 when setting the quantity of an item that is not in the cart', async () => {
      const token = await registerWithPassword('jane@example.com');

      const res = await setQuantity(token, 'E_S1', 2).expect(404);

      expect(res.body.code).toBe('CART-004');
      expect((await view(token)).body.data.items).toEqual([]);
    });

    it('answers 400 for a quantity that makes no sense and for fields that are not allowed', async () => {
      const token = await registerWithPassword('jane@example.com');

      // (a number written as text, "2", is read as 2 by the pipe that checks every request)
      for (const quantity of [0, -1, 1.5, 1001, 'two', null]) {
        await add(token, 'E_S1', quantity).expect(400);
      }
      for (const quantity of [0, -1, 1.5, 1001, 'two', null]) {
        await add(token, 'E_S1').expect(201); // so the line exists
        await setQuantity(token, 'E_S1', quantity).expect(400);
      }
      await http()
        .post(`${CART}/items`)
        .set(authed(token))
        .send({ skuId: 'E_S1' }) // no quantity
        .expect(400);
      await http()
        .post(`${CART}/items`)
        .set(authed(token))
        .send({ quantity: 1 }) // no SKU
        .expect(400);
      await http()
        .post(`${CART}/items`)
        .set(authed(token))
        .send({ skuId: '', quantity: 1 })
        .expect(400);
      await http()
        .post(`${CART}/items`)
        .set(authed(token))
        .send({ skuId: 'E_S1', quantity: 1, price: 1 })
        .expect(400);
      await http()
        .post(`${CART}/items`)
        .set(authed(token))
        .send({ skuId: 'E_S1', quantity: 1, userId: 'someone' })
        .expect(400);
      await http()
        .put(`${CART}/items/E_S1`)
        .set(authed(token))
        .send({ quantity: 1, addedPrice: 1 })
        .expect(400);
    });
  });

  it('does not let one user see or change the cart of another (AC-13)', async () => {
    const jane = await registerWithPassword('jane@example.com');
    const john = await registerWithPassword('john@example.com');
    await add(jane, 'E_S1', 2).expect(201);

    expect((await view(john).expect(200)).body.data.items).toEqual([]);
    await setQuantity(john, 'E_S1', 9).expect(404); // john has no such line
    await add(john, 'E_S1', 1).expect(201);
    await http().delete(`${CART}/items/E_S1`).set(authed(john)).expect(204);
    await http().delete(CART).set(authed(john)).expect(204);

    const janes = (await view(jane).expect(200)).body.data;
    expect(janes.items).toHaveLength(1);
    expect(janes.items[0].quantity).toBe(2);
    expect(JSON.stringify(janes)).not.toMatch(/userId|cart_user|jane@/);
  });

  describe('several requests at the same time (AC-11)', () => {
    it('loses no addition: 20 simultaneous adds make 20', async () => {
      const token = await registerWithPassword('jane@example.com');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => add(token, 'E_S1', 1)),
      );

      expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
      expect((await view(token)).body.data.items[0].quantity).toBe(20);
    });

    it('never goes over 99 of one item when adds race: 90 there, 20 more at once let exactly 9 in', async () => {
      const token = await registerWithPassword('jane@example.com');
      await add(token, 'E_S1', 90).expect(201);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => add(token, 'E_S1', 1)),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(9);
      const refused = results.filter((r) => r.status === 409);
      expect(refused).toHaveLength(11);
      for (const r of refused) expect(r.body.code).toBe('CART-002');
      expect((await view(token)).body.data.items[0].quantity).toBe(99);
    });
  });

  it('allows 60 views a minute and then answers 429 (AC-14)', async () => {
    const token = await registerWithPassword('jane@example.com');

    for (let i = 0; i < 60; i++) await view(token).expect(200);
    await view(token).expect(429);
    // each endpoint is counted on its own
    await add(token, 'E_S1').expect(201);
  });
});
