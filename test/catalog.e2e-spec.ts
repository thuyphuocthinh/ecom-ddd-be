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
});
