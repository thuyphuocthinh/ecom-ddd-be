import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  JwtAuthGuard,
  RolesGuard,
} from './../src/core/index.js';
import { ClsService } from 'nestjs-cls';

// The guards are switched off here so the business behaviour can be tested on
// its own. That the admin endpoints really refuse non-admins (AC-15) is tested
// with the real guards in auth.e2e-spec.ts.
const PUBLIC = '/api/v1/catalog';
const ADMIN = '/api/v1/admin/catalog';

describe('CatalogController (e2e)', () => {
  let app: INestApplication;
  let prismaService: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();

    // Same options as main.ts: an unknown field (such as `status` on the public
    // product list) is rejected with 400.
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
    app.setGlobalPrefix('api/v1');

    await app.init();

    prismaService = app.get(PrismaService);
  });

  beforeEach(async () => {
    // Reservations point at SKUs with ON DELETE RESTRICT: they must go first
    await prismaService.reservation.deleteMany();
    await prismaService.product.deleteMany();
    await prismaService.category.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const createCategory = async (
    name: string,
    parentId?: string,
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`${ADMIN}/categories`)
      .send({ name, parentId })
      .expect(201);
    return res.body.data.id;
  };

  let skuCounter = 0;
  /** Creates a product (with one SKU when `price` is given), optionally publishing it. */
  const createProduct = async (
    categoryId: string,
    name: string,
    options: { price?: number; publish?: boolean; description?: string } = {},
  ): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post(`${ADMIN}/products`)
      .send({
        categoryId,
        name,
        description: options.description,
        skus:
          options.price === undefined
            ? []
            : [
                {
                  skuCode: `SKU-${++skuCounter}-${Date.now()}`,
                  price: options.price,
                  attributes: {},
                },
              ],
      })
      .expect(201);
    const id: string = res.body.data.id;
    if (options.publish) {
      await request(app.getHttpServer())
        .patch(`${ADMIN}/products/${id}/publish`)
        .expect(200);
    }
    return id;
  };

  const publicNames = async (query = ''): Promise<string[]> => {
    const res = await request(app.getHttpServer())
      .get(`${PUBLIC}/products${query}`)
      .expect(200);
    return res.body.data.map((p: { name: string }) => p.name).sort();
  };

  // ── categories and products (admin writes) ─────────────────────────────────

  describe('/api/v1/admin/catalog/categories (POST)', () => {
    it('should create a root category', async () => {
      const res = await request(app.getHttpServer())
        .post(`${ADMIN}/categories`)
        .send({
          name: 'Electronics',
        })
        .expect(201);

      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.name).toBe('Electronics');
      expect(res.body.data.path).toContain('/');
    });

    it('should replay the same response on a repeated Idempotency-Key instead of creating a duplicate', async () => {
      const idempotencyKey = `test-key-${Date.now()}`;

      const first = await request(app.getHttpServer())
        .post(`${ADMIN}/categories`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Books' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post(`${ADMIN}/categories`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Books' })
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);

      const all = await request(app.getHttpServer()).get(
        `${PUBLIC}/categories`,
      );
      const matching = all.body.data.filter(
        (c: { name: string }) => c.name === 'Books',
      );
      expect(matching).toHaveLength(1);
    });

    it('should reject reusing an Idempotency-Key with a different payload', async () => {
      const idempotencyKey = `test-key-mismatch-${Date.now()}`;

      await request(app.getHttpServer())
        .post(`${ADMIN}/categories`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Toys' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`${ADMIN}/categories`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Garden' })
        .expect(409);
    });
  });

  describe('/api/v1/admin/catalog/products (POST)', () => {
    it('should create a product with skus', async () => {
      // 1. Create a category first
      const categoryId = await createCategory('Laptops');

      // 2. Create a product
      const res = await request(app.getHttpServer())
        .post(`${ADMIN}/products`)
        .send({
          categoryId,
          name: 'MacBook Pro',
          description: 'Apple Laptop',
          thumbnail: 'macbook.jpg',
          skus: [
            {
              skuCode: 'MBP-14',
              price: 1999,
              attributes: { color: 'Silver', ram: '16GB' },
            },
          ],
        })
        .expect(201);

      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.name).toBe('MacBook Pro');
      expect(res.body.data.skus).toHaveLength(1);
      expect(res.body.data.skus[0].skuCode).toBe('MBP-14');
    });

    it('should fail if category does not exist', async () => {
      await request(app.getHttpServer())
        .post(`${ADMIN}/products`)
        .send({
          categoryId: 'non_existent_category',
          name: 'Fake Product',
          skus: [],
        })
        .expect(404); // CAT-005 CATEGORY_NOT_FOUND
    });
  });

  // ── public list: filters ───────────────────────────────────────────────────

  describe('/api/v1/catalog/products (GET with Filters)', () => {
    it('should search products by name/description and filter by price', async () => {
      const categoryId = await createCategory('Laptops');
      await createProduct(categoryId, 'MacBook Pro', {
        price: 1999,
        publish: true,
        description: 'Apple Laptop M3',
      });
      await createProduct(categoryId, 'Dell XPS', {
        price: 999,
        publish: true,
        description: 'Windows Laptop',
      });

      expect(await publicNames('?search=apple')).toEqual(['MacBook Pro']);
      expect(await publicNames('?minPrice=1000')).toEqual(['MacBook Pro']);
      expect(await publicNames('?maxPrice=1000')).toEqual(['Dell XPS']);
    });
  });

  // ── AC-10 to AC-13: what a customer can see ────────────────────────────────

  describe('AC-10: the public list only has published products', () => {
    it('hides draft and archived products', async () => {
      const categoryId = await createCategory('Phones');
      await createProduct(categoryId, 'Published phone', {
        price: 100,
        publish: true,
      });
      await createProduct(categoryId, 'Draft phone', { price: 100 });
      const archivedId = await createProduct(categoryId, 'Archived phone', {
        price: 100,
      });
      await prismaService.product.update({
        where: { id: archivedId },
        data: { status: 'ARCHIVED' },
      });

      expect(await publicNames()).toEqual(['Published phone']);
    });

    it('pages over published products only: no empty page, hasMore is right', async () => {
      const categoryId = await createCategory('Phones');
      // Draft products sit between the published ones in id order
      await createProduct(categoryId, 'Published 1', {
        price: 100,
        publish: true,
      });
      await createProduct(categoryId, 'Draft between', { price: 100 });
      await createProduct(categoryId, 'Published 2', {
        price: 100,
        publish: true,
      });

      const first = await request(app.getHttpServer())
        .get(`${PUBLIC}/products?limit=1`)
        .expect(200);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.meta.hasMore).toBe(true);

      const second = await request(app.getHttpServer())
        .get(`${PUBLIC}/products?limit=1&cursor=${first.body.meta.nextCursor}`)
        .expect(200);
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta.hasMore).toBe(false);

      const names = [first, second].map((r) => r.body.data[0].name).sort();
      expect(names).toEqual(['Published 1', 'Published 2']);
    });
  });

  describe('AC-11: the public list does not accept `status`', () => {
    it('answers 400 and returns no draft product', async () => {
      const categoryId = await createCategory('Phones');
      await createProduct(categoryId, 'Draft phone', { price: 100 });

      const res = await request(app.getHttpServer())
        .get(`${PUBLIC}/products?status=DRAFT`)
        .expect(400);

      expect(JSON.stringify(res.body)).not.toContain('Draft phone');
    });
  });

  describe('AC-12: product details are public only for published products', () => {
    it('answers 404 CAT-010 for a draft product, like for an id that does not exist', async () => {
      const categoryId = await createCategory('Phones');
      const draftId = await createProduct(categoryId, 'Draft phone', {
        price: 100,
      });

      const hidden = await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${draftId}`)
        .expect(404);
      const missing = await request(app.getHttpServer())
        .get(`${PUBLIC}/products/does-not-exist`)
        .expect(404);

      expect(hidden.body.code).toBe('CAT-010');
      expect(missing.body.code).toBe('CAT-010');
      expect(hidden.body.statusCode).toBe(missing.body.statusCode);
    });

    it('answers 404 for an archived product', async () => {
      const categoryId = await createCategory('Phones');
      const id = await createProduct(categoryId, 'Archived phone', {
        price: 100,
      });
      await prismaService.product.update({
        where: { id },
        data: { status: 'ARCHIVED' },
      });

      await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${id}`)
        .expect(404);
    });

    it('returns a published product with all its SKUs', async () => {
      const categoryId = await createCategory('Phones');
      const id = await createProduct(categoryId, 'Published phone', {
        price: 100,
        publish: true,
      });

      const res = await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${id}`)
        .expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.skus).toHaveLength(1);
    });
  });

  describe('AC-13: hiding a product takes effect at once, even after it was cached', () => {
    it('answers 404 right after unpublish and 200 again after publish', async () => {
      const categoryId = await createCategory('Phones');
      const id = await createProduct(categoryId, 'Phone', {
        price: 100,
        publish: true,
      });

      // This read puts the product in the cache
      await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${id}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`${ADMIN}/products/${id}/unpublish`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${id}`)
        .expect(404);
      expect(await publicNames()).toEqual([]);

      await request(app.getHttpServer())
        .patch(`${ADMIN}/products/${id}/publish`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`${PUBLIC}/products/${id}`)
        .expect(200);
    });
  });

  // ── AC-14: what an admin can see ───────────────────────────────────────────

  describe('AC-14: an admin sees products in every status', () => {
    it('lists, filters by status and reads a draft product by id', async () => {
      const categoryId = await createCategory('Phones');
      const publishedId = await createProduct(categoryId, 'Published phone', {
        price: 100,
        publish: true,
      });
      const draftId = await createProduct(categoryId, 'Draft phone', {
        price: 100,
      });
      const archivedId = await createProduct(categoryId, 'Archived phone', {
        price: 100,
      });
      await prismaService.product.update({
        where: { id: archivedId },
        data: { status: 'ARCHIVED' },
      });

      const all = await request(app.getHttpServer())
        .get(`${ADMIN}/products`)
        .expect(200);
      expect(all.body.data.map((p: { id: string }) => p.id).sort()).toEqual(
        [publishedId, draftId, archivedId].sort(),
      );

      const drafts = await request(app.getHttpServer())
        .get(`${ADMIN}/products?status=DRAFT`)
        .expect(200);
      expect(drafts.body.data.map((p: { id: string }) => p.id)).toEqual([
        draftId,
      ]);

      const draft = await request(app.getHttpServer())
        .get(`${ADMIN}/products/${draftId}`)
        .expect(200);
      expect(draft.body.data.status).toBe('DRAFT');
    });

    it('applies the same filters as the public list', async () => {
      const categoryId = await createCategory('Phones');
      await createProduct(categoryId, 'Cheap draft', { price: 100 });
      await createProduct(categoryId, 'Dear draft', { price: 900 });

      const res = await request(app.getHttpServer())
        .get(`${ADMIN}/products?minPrice=500`)
        .expect(200);

      expect(res.body.data.map((p: { name: string }) => p.name)).toEqual([
        'Dear draft',
      ]);
    });
  });

  // ── AC-16 to AC-20: category tree filter ───────────────────────────────────

  describe('AC-16: filtering by category includes every sub-category', () => {
    it('returns the products of the category and of everything below it', async () => {
      const electronics = await createCategory('Electronics');
      const phones = await createCategory('Phones', electronics);
      const iphones = await createCategory('iPhones', phones);
      const laptops = await createCategory('Laptops', electronics);
      const fashion = await createCategory('Fashion');
      const publish = { price: 100, publish: true };
      await createProduct(electronics, 'In electronics', publish);
      await createProduct(phones, 'In phones', publish);
      await createProduct(iphones, 'In iphones', publish);
      await createProduct(laptops, 'In laptops', publish);
      await createProduct(fashion, 'In fashion', publish);

      expect(await publicNames(`?categoryId=${electronics}`)).toEqual([
        'In electronics',
        'In iphones',
        'In laptops',
        'In phones',
      ]);
      expect(await publicNames(`?categoryId=${phones}`)).toEqual([
        'In iphones',
        'In phones',
      ]);
      expect(await publicNames(`?categoryId=${fashion}`)).toEqual([
        'In fashion',
      ]);
    });

    it('does the same on the admin list', async () => {
      const electronics = await createCategory('Electronics');
      const phones = await createCategory('Phones', electronics);
      await createProduct(phones, 'Draft in phones', { price: 100 });

      const res = await request(app.getHttpServer())
        .get(`${ADMIN}/products?categoryId=${electronics}`)
        .expect(200);

      expect(res.body.data.map((p: { name: string }) => p.name)).toEqual([
        'Draft in phones',
      ]);
    });
  });

  describe('AC-19: moving a category changes what the filter returns', () => {
    it('follows the category to its new parent, not the cached old one', async () => {
      const electronics = await createCategory('Electronics');
      const fashion = await createCategory('Fashion');
      const phones = await createCategory('Phones', electronics);
      await createProduct(phones, 'A phone', { price: 100, publish: true });

      // These reads put the categories in the cache
      expect(await publicNames(`?categoryId=${electronics}`)).toEqual([
        'A phone',
      ]);
      expect(await publicNames(`?categoryId=${fashion}`)).toEqual([]);

      await request(app.getHttpServer())
        .patch(`${ADMIN}/categories/${phones}/move`)
        .send({ newParentId: fashion })
        .expect(200);

      expect(await publicNames(`?categoryId=${electronics}`)).toEqual([]);
      expect(await publicNames(`?categoryId=${fashion}`)).toEqual(['A phone']);
    });
  });

  describe('AC-20: an unknown category gives an empty list', () => {
    it('answers 200 with no products', async () => {
      const categoryId = await createCategory('Phones');
      await createProduct(categoryId, 'A phone', { price: 100, publish: true });

      const res = await request(app.getHttpServer())
        .get(`${PUBLIC}/products?categoryId=does-not-exist`)
        .expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.meta.hasMore).toBe(false);
    });
  });

  // ── AC-21: the admin routes moved ──────────────────────────────────────────

  describe('AC-21: write endpoints only exist under /admin/catalog', () => {
    it('no longer serves the old write paths', async () => {
      const categoryId = await createCategory('Phones');
      const productId = await createProduct(categoryId, 'A phone', {
        price: 100,
      });

      const http = () => request(app.getHttpServer());
      await http().post(`${PUBLIC}/categories`).send({ name: 'X' }).expect(404);
      await http()
        .post(`${PUBLIC}/products`)
        .send({ categoryId, name: 'X', skus: [] })
        .expect(404);
      await http().patch(`${PUBLIC}/products/${productId}/publish`).expect(404);
      await http().delete(`${PUBLIC}/categories/${categoryId}`).expect(404);
    });

    it('keeps the public reads working without a token', async () => {
      await request(app.getHttpServer()).get(`${PUBLIC}/products`).expect(200);
      await request(app.getHttpServer())
        .get(`${PUBLIC}/categories`)
        .expect(200);
    });
  });

  // ── AC-22: a SKU inventory has held cannot be removed ──────────────────────

  describe('AC-22: removing a SKU that was held for an order', () => {
    it('answers 409 CAT-016 and keeps the SKU, while a SKU that was never held can still be removed', async () => {
      const categoryId = await createCategory('Phones');
      const productId = await createProduct(categoryId, 'Phone', {
        price: 100,
      });
      const added = await request(app.getHttpServer())
        .post(`${ADMIN}/products/${productId}/skus`)
        .send({
          skuCode: `FREE-${Date.now()}`,
          price: 120,
          attributes: { c: 'x' },
        })
        .expect(201);
      const heldSku = (
        await prismaService.sku.findFirstOrThrow({
          where: { productId, id: { not: added.body.data.id } },
        })
      ).id;
      await prismaService.reservation.create({
        data: {
          id: 'res_e2e',
          orderId: 'order_e2e',
          skuId: heldSku,
          qty: 1,
          status: 'RESERVED',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const refused = await request(app.getHttpServer())
        .delete(`${ADMIN}/products/${productId}/skus/${heldSku}`)
        .expect(409);
      expect(refused.body.code).toBe('CAT-016');
      expect(await prismaService.sku.count({ where: { id: heldSku } })).toBe(1);

      await request(app.getHttpServer())
        .delete(`${ADMIN}/products/${productId}/skus/${added.body.data.id}`)
        .expect(204);
    });
  });

  // ── admin writes that already existed ──────────────────────────────────────

  describe('/api/v1/admin/catalog/categories/:id (DELETE)', () => {
    it('should delete a category with no products', async () => {
      const categoryId = await createCategory('Empty Category');

      await request(app.getHttpServer())
        .delete(`${ADMIN}/categories/${categoryId}`)
        .expect(204);
    });

    it('should not delete a category with products', async () => {
      const categoryId = await createCategory('Laptops');
      await createProduct(categoryId, 'MacBook');

      await request(app.getHttpServer())
        .delete(`${ADMIN}/categories/${categoryId}`)
        .expect(409); // CAT-011 CATEGORY_HAS_PRODUCTS
    });
  });

  describe('/api/v1/admin/catalog/categories/:id/move (PATCH)', () => {
    it('should move a category to a new parent', async () => {
      const rootId = await createCategory('Root 1');
      const childId = await createCategory('Child 1', rootId);
      const newRootId = await createCategory('Root 2');

      const moveRes = await request(app.getHttpServer())
        .patch(`${ADMIN}/categories/${childId}/move`)
        .send({ newParentId: newRootId })
        .expect(200);

      expect(moveRes.body.data.path).toContain(`/${newRootId}/${childId}/`);
    });
  });

  describe('/api/v1/admin/catalog/products/:id/publish (PATCH)', () => {
    it('should publish a product successfully', async () => {
      const categoryId = await createCategory('Laptops');
      const productId = await createProduct(categoryId, 'MacBook Pro', {
        price: 1999,
      });

      const publishRes = await request(app.getHttpServer())
        .patch(`${ADMIN}/products/${productId}/publish`)
        .expect(200);

      expect(publishRes.body.data.status).toBe('PUBLISHED');
    });

    it('should not publish a product without skus', async () => {
      const categoryId = await createCategory('Laptops');
      const productId = await createProduct(categoryId, 'Empty MacBook');

      await request(app.getHttpServer())
        .patch(`${ADMIN}/products/${productId}/publish`)
        .expect(400); // CAT-003 INVALID_PUBLISH
    });
  });
  // ── search, stock labels and discounts (AC-24 to AC-33) ────────────────────

  describe('searching the public list (AC-24 to AC-33)', () => {
    const get = (path: string) =>
      request(app.getHttpServer()).get(`${PUBLIC}${path}`);
    /** A published product with the SKUs given: its price, original price and units on hand. */
    const make = async (
      categoryId: string,
      name: string,
      skus: { price: number; compareAtPrice?: number; onHand?: number }[],
      options: { publish?: boolean; description?: string } = {},
    ) => {
      const created = await request(app.getHttpServer())
        .post(`${ADMIN}/products`)
        .send({
          categoryId,
          name,
          description: options.description,
          skus: skus.map((sku, i) => ({
            skuCode: `SRCH-${++skuCounter}-${i}`,
            price: sku.price,
            compareAtPrice: sku.compareAtPrice,
            attributes: { n: String(i) },
          })),
        })
        .expect(201);
      const id: string = created.body.data.id;
      if (options.publish !== false) {
        await request(app.getHttpServer())
          .patch(`${ADMIN}/products/${id}/publish`)
          .expect(200);
      }
      const detail = await prismaService.sku.findMany({
        where: { productId: id },
        orderBy: { skuCode: 'asc' },
      });
      for (const [i, sku] of skus.entries()) {
        if (sku.onHand !== undefined) {
          await prismaService.skuStock.create({
            data: { skuId: detail[i].id, onHand: sku.onHand },
          });
        }
      }
      return { id, skuIds: detail.map((d) => d.id) };
    };
    const names = (res: { body: { data: { name: string }[] } }) =>
      res.body.data.map((p) => p.name);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

    it('lists the newest product first, and each product says what a storefront needs (AC-24, AC-27, AC-29, AC-30)', async () => {
      const cat = await createCategory('Audio');
      await make(cat, 'Old', [{ price: 100, onHand: 1 }]);
      await pause();
      await make(cat, 'Aero 2', [
        { price: 3_990_000, compareAtPrice: 4_590_000, onHand: 4 },
        { price: 4_500_000, onHand: 0 },
      ]);

      const res = await get('/products').expect(200);

      expect(names(res)).toEqual(['Aero 2', 'Old']);
      const aero = res.body.data[0];
      expect(aero).toMatchObject({
        minPrice: 3_990_000,
        onSale: true,
        discountPercent: 13,
        inStock: true,
      });
      expect(
        aero.skus.map((x: any) => [
          x.price,
          x.compareAtPrice,
          x.discountPercent,
          x.inStock,
        ]),
      ).toEqual([
        [3_990_000, 4_590_000, 13, true],
        [4_500_000, null, 0, false],
      ]);
      expect(Object.keys(res.body.meta).sort()).toEqual([
        'hasMore',
        'nextCursor',
      ]);
    });

    it('goes through the pages with a cursor, once each (AC-24)', async () => {
      const cat = await createCategory('Cursor');
      for (const n of ['a', 'b', 'c', 'd', 'e']) {
        await make(cat, `Item ${n}`, [{ price: 10 }]);
        await pause();
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await get('/products')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...names(res));
        cursor = res.body.meta.nextCursor ?? undefined;
      } while (cursor);

      expect(seen).toEqual(['Item e', 'Item d', 'Item c', 'Item b', 'Item a']);
    });

    it('reads numbered pages with the total, and sorts by price either way (AC-25, AC-26)', async () => {
      const cat = await createCategory('Pages');
      for (const [name, price] of [
        ['p1', 300],
        ['p2', 100],
        ['p3', 200],
        ['p4', 500],
        ['p5', 400],
      ] as const) {
        await make(cat, name, [{ price }]);
      }

      const page2 = await get('/products')
        .query({ page: 2, limit: 2, sort: 'price_asc' })
        .expect(200);
      const page3 = await get('/products')
        .query({ page: 3, limit: 2, sort: 'price_asc' })
        .expect(200);
      const desc = await get('/products')
        .query({ page: 1, limit: 5, sort: 'price_desc' })
        .expect(200);

      expect(names(page2)).toEqual(['p1', 'p5']);
      expect(page2.body.meta).toEqual({
        page: 2,
        limit: 2,
        hasMore: true,
        total: 5,
        totalCapped: false,
      });
      expect(names(page3)).toEqual(['p4']);
      expect(page3.body.meta.hasMore).toBe(false);
      expect(names(desc)).toEqual(['p4', 'p5', 'p1', 'p3', 'p2']);
    });

    it('sorts by relevance when there is a search (AC-26)', async () => {
      const cat = await createCategory('Relevance');
      await make(cat, 'Headphones', [{ price: 10 }], {
        description: 'headphones',
      });
      await make(cat, 'Headphones headphones headphones', [{ price: 10 }], {
        description: 'headphones headphones',
      });
      await make(cat, 'Speaker', [{ price: 10 }]);

      const res = await get('/products')
        .query({ search: 'headphones', sort: 'relevance', page: 1 })
        .expect(200);

      expect(names(res)).toEqual([
        'Headphones headphones headphones',
        'Headphones',
      ]);
    });

    it('filters by stock and by discount, and a draft is never counted (AC-28, AC-29, AC-30, AC-33)', async () => {
      const cat = await createCategory('Filters');
      await make(cat, 'In stock', [{ price: 10, onHand: 3 }]);
      await make(cat, 'Sold out', [{ price: 10, onHand: 0 }]);
      await make(cat, 'On sale', [
        { price: 10, compareAtPrice: 20, onHand: 1 },
      ]);
      await make(
        cat,
        'Hidden draft',
        [{ price: 10, compareAtPrice: 20, onHand: 1 }],
        { publish: false },
      );

      const inStock = await get('/products')
        .query({ inStock: 'true', page: 1 })
        .expect(200);
      const onSale = await get('/products')
        .query({ onSale: 'true', page: 1 })
        .expect(200);
      const both = await get('/products')
        .query({ inStock: 'true', onSale: 'true', page: 1 })
        .expect(200);
      const all = await get('/products').query({ page: 1 }).expect(200);

      expect(names(inStock).sort()).toEqual(['In stock', 'On sale']);
      expect(names(onSale)).toEqual(['On sale']);
      expect(names(both)).toEqual(['On sale']);
      expect(all.body.meta.total).toBe(3);
      expect(
        all.body.data.find((p: any) => p.name === 'Sold out').inStock,
      ).toBe(false);
    });

    it.each([
      ['page together with cursor', { page: 1, cursor: 'x' }, 'CAT-017'],
      [
        'a cursor with another sort',
        { cursor: 'x', sort: 'price_asc' },
        'CAT-017',
      ],
      ['relevance with no search', { page: 1, sort: 'relevance' }, 'CAT-017'],
      [
        'a page past the first 1000 results',
        { page: 21, limit: 50 },
        'CAT-017',
      ],
      [
        'a cursor that is not a product',
        { cursor: 'no-such-product' },
        'CAT-017',
      ],
      ['an unknown sort', { sort: 'cheapest' }, 'VAL-001'],
      ['inStock=false', { inStock: 'false' }, 'VAL-001'],
      ['onSale=1', { onSale: '1' }, 'VAL-001'],
      ['limit 51', { limit: 51 }, 'VAL-001'],
      ['page 0', { page: 0 }, 'VAL-001'],
    ])('refuses %s with 400', async (_label, query, code) => {
      const res = await get('/products').query(query).expect(400);

      expect(res.body.code).toBe(code);
    });

    it('shows the stock in the detail of a product even right after it was cached, and not for a hidden one (AC-29)', async () => {
      const cat = await createCategory('Detail');
      const { id, skuIds } = await make(cat, 'Cached', [
        { price: 10, onHand: 2 },
      ]);

      const first = await get(`/products/${id}`).expect(200);
      await prismaService.skuStock.update({
        where: { skuId: skuIds[0] },
        data: { onHand: 0 },
      });
      const second = await get(`/products/${id}`).expect(200);

      expect(first.body.data).toMatchObject({ inStock: true, minPrice: 10 });
      expect(first.body.data.skus[0].inStock).toBe(true);
      expect(second.body.data.inStock).toBe(false);
      expect(second.body.data.skus[0].inStock).toBe(false);
    });

    it('counts the products of each category, below it included; facets is not taken for a product id (AC-31)', async () => {
      const audio = await createCategory('Audio');
      const earbuds = await createCategory('Earbuds', audio);
      const bags = await createCategory('Bags');
      await createCategory('Nothing');
      await make(earbuds, 'Aero', [{ price: 10, onHand: 1 }]);
      await make(audio, 'Speaker', [{ price: 10, onHand: 0 }]);
      await make(bags, 'Backpack', [{ price: 10, onHand: 1 }]);
      await make(bags, 'Draft bag', [{ price: 10, onHand: 1 }], {
        publish: false,
      });

      const roots = await get('/products/facets').expect(200);
      const stocked = await get('/products/facets')
        .query({ inStock: 'true' })
        .expect(200);
      const below = await get('/products/facets')
        .query({ parentId: audio })
        .expect(200);
      const nobody = await get('/products/facets')
        .query({ parentId: 'no-such' })
        .expect(200);
      const byName = (res: {
        body: { data: { name: string; count: number }[] };
      }) => Object.fromEntries(res.body.data.map((c) => [c.name, c.count]));

      expect(byName(roots)).toEqual({ Audio: 2, Bags: 1, Nothing: 0 });
      expect(byName(stocked)).toEqual({ Audio: 1, Bags: 1, Nothing: 0 });
      expect(byName(below)).toEqual({ Earbuds: 1 });
      expect(nobody.body.data).toEqual([]);
      expect(Object.keys(roots.body.data[0]).sort()).toEqual([
        'categoryId',
        'count',
        'name',
      ]);
      for (const query of [
        { categoryId: audio },
        { sort: 'price_asc' },
        { page: 1 },
        { cursor: 'x' },
        { limit: 5 },
        { onSale: 'false' },
      ]) {
        await get('/products/facets').query(query).expect(400);
      }
    });

    it('lets the admin set, change and remove the price before a discount; money stays at price (AC-30)', async () => {
      const cat = await createCategory('Sale');
      const { id, skuIds } = await make(cat, 'Aero 2', [{ price: 4_590_000 }]);
      const priceUrl = `${ADMIN}/products/${id}/skus/${skuIds[0]}/price`;

      const set = await request(app.getHttpServer())
        .patch(priceUrl)
        .send({ price: 3_990_000, compareAtPrice: 4_590_000 })
        .expect(200);
      expect(set.body.data.skus[0]).toMatchObject({
        price: 3_990_000,
        compareAtPrice: 4_590_000,
        discountPercent: 13,
      });
      expect(set.body.data.skus[0]).not.toHaveProperty('inStock'); // the admin sees no storefront flags
      expect(set.body.data.onSale).toBe(true);

      // leaving it out keeps it
      const kept = await request(app.getHttpServer())
        .patch(priceUrl)
        .send({ price: 3_900_000 })
        .expect(200);
      expect(kept.body.data.skus[0]).toMatchObject({
        price: 3_900_000,
        compareAtPrice: 4_590_000,
      });

      // the storefront shows it, and the cart-facing price is the selling price
      const shown = await get(`/products/${id}`).expect(200);
      expect(shown.body.data.skus[0]).toMatchObject({
        price: 3_900_000,
        compareAtPrice: 4_590_000,
      });

      // a price that reaches the original, or an original that is not above, is refused
      for (const body of [
        { price: 4_590_000 },
        { price: 5_000_000 },
        { price: 3_900_000, compareAtPrice: 3_900_000 },
        { price: 3_900_000, compareAtPrice: 100 },
      ]) {
        const res = await request(app.getHttpServer())
          .patch(priceUrl)
          .send(body)
          .expect(400);
        expect(res.body.code).toBe('CAT-018');
      }
      expect((await get(`/products/${id}`)).body.data.skus[0].price).toBe(
        3_900_000,
      );

      // null removes the discount, and then the price may go up past the old original
      const removed = await request(app.getHttpServer())
        .patch(priceUrl)
        .send({ price: 5_000_000, compareAtPrice: null })
        .expect(200);
      expect(removed.body.data.skus[0]).toMatchObject({
        price: 5_000_000,
        compareAtPrice: null,
        discountPercent: 0,
      });
      expect(removed.body.data.onSale).toBe(false);
      await request(app.getHttpServer())
        .patch(priceUrl)
        .send({ price: 1, compareAtPrice: 'cheap' })
        .expect(400);
    });

    it('takes the price before a discount when a product or a SKU is created (AC-30)', async () => {
      const cat = await createCategory('Create');
      const { id } = await make(cat, 'With original', [
        { price: 100, compareAtPrice: 150 },
      ]);
      const added = await request(app.getHttpServer())
        .post(`${ADMIN}/products/${id}/skus`)
        .send({
          skuCode: `ADD-${Date.now()}`,
          price: 200,
          compareAtPrice: 260,
          attributes: { size: 'L' },
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`${ADMIN}/products/${id}/skus`)
        .send({
          skuCode: `BAD-${Date.now()}`,
          price: 200,
          compareAtPrice: 200,
          attributes: { size: 'XL' },
        })
        .expect(400);
      await request(app.getHttpServer())
        .post(`${ADMIN}/products`)
        .send({
          categoryId: cat,
          name: 'Bad',
          skus: [
            {
              skuCode: `B-${Date.now()}`,
              price: 10,
              compareAtPrice: 5,
              attributes: {},
            },
          ],
        })
        .expect(400);

      expect(added.body.data.compareAtPrice).toBe(260);
      expect((await get(`/products/${id}`)).body.data).toMatchObject({
        minPrice: 100,
        onSale: true,
        discountPercent: 33,
      });
    });

    it('does not change the admin list: no page, sort, inStock or onSale, and the cursor still works (AC-32)', async () => {
      const cat = await createCategory('Admin');
      await make(cat, 'One', [{ price: 10 }]);
      await make(cat, 'Draft', [{ price: 10 }], { publish: false });

      const list = await request(app.getHttpServer())
        .get(`${ADMIN}/products`)
        .expect(200);

      expect(list.body.data).toHaveLength(2);
      expect(Object.keys(list.body.meta).sort()).toEqual([
        'hasMore',
        'nextCursor',
      ]);
      expect(list.body.data[0]).not.toHaveProperty('inStock');
      for (const query of [
        { page: 1 },
        { sort: 'price_asc' },
        { inStock: 'true' },
        { onSale: 'true' },
        { limit: 51 },
      ]) {
        await request(app.getHttpServer())
          .get(`${ADMIN}/products`)
          .query(query)
          .expect(400);
      }
    });
  });
});
