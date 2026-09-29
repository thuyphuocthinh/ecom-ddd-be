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

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
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

  describe('/api/v1/catalog/categories (POST)', () => {
    it('should create a root category', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
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
        .post('/api/v1/catalog/categories')
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Books' })
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Books' })
        .expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);

      const all = await request(app.getHttpServer()).get(
        '/api/v1/catalog/categories',
      );
      const matching = all.body.data.filter(
        (c: { name: string }) => c.name === 'Books',
      );
      expect(matching).toHaveLength(1);
    });

    it('should reject reusing an Idempotency-Key with a different payload', async () => {
      const idempotencyKey = `test-key-mismatch-${Date.now()}`;

      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Toys' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Idempotency-Key', idempotencyKey)
        .send({ name: 'Garden' })
        .expect(409);
    });
  });

  describe('/api/v1/catalog/products (POST)', () => {
    it('should create a product with skus', async () => {
      // 1. Create a category first
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Laptops' });

      const categoryId = categoryRes.body.data.id;

      // 2. Create a product
      const res = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
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
        .post('/api/v1/catalog/products')
        .send({
          categoryId: 'non_existent_category',
          name: 'Fake Product',
          skus: [],
        })
        .expect(404); // CAT-005 CATEGORY_NOT_FOUND
    });
  });

  describe('/api/v1/catalog/products (GET with Filters)', () => {
    it('should search products by name/description and filter by price/status', async () => {
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Laptops' });
      const categoryId = categoryRes.body.data.id;

      // Product 1 (MacBook - $1999) - Published
      const p1 = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({
          categoryId,
          name: 'MacBook Pro',
          description: 'Apple Laptop M3',
          skus: [{ skuCode: 'MBP', price: 1999, attributes: {} }],
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${p1.body.data.id}/publish`)
        .expect(200);

      // Product 2 (Dell - $999) - Draft
      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({
          categoryId,
          name: 'Dell XPS',
          description: 'Windows Laptop',
          skus: [{ skuCode: 'DELL', price: 999, attributes: {} }],
        });

      // Search 'apple' (description match)
      let res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?search=apple')
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('MacBook Pro');

      // Filter status PUBLISHED
      res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?status=PUBLISHED')
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('MacBook Pro');

      // Filter minPrice 1000
      res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?minPrice=1000')
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('MacBook Pro');

      // Filter maxPrice 1000
      res = await request(app.getHttpServer())
        .get('/api/v1/catalog/products?maxPrice=1000')
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Dell XPS');
    });
  });

  describe('/api/v1/catalog/categories/:id (DELETE)', () => {
    it('should delete a category with no products', async () => {
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Empty Category' });

      const categoryId = categoryRes.body.data.id;

      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/categories/${categoryId}`)
        .expect(204);
    });

    it('should not delete a category with products', async () => {
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Laptops' });
      const categoryId = categoryRes.body.data.id;

      await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({ categoryId, name: 'MacBook', skus: [] });

      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/categories/${categoryId}`)
        .expect(409); // CAT-011 CATEGORY_HAS_PRODUCTS
    });
  });

  describe('/api/v1/catalog/categories/:id/move (PATCH)', () => {
    it('should move a category to a new parent', async () => {
      const rootRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Root 1' });

      const childRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Child 1', parentId: rootRes.body.data.id });

      const newRootRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Root 2' });

      const moveRes = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/categories/${childRes.body.data.id}/move`)
        .send({ newParentId: newRootRes.body.data.id })
        .expect(200);

      expect(moveRes.body.data.path).toContain(
        `/${newRootRes.body.data.id}/${childRes.body.data.id}/`,
      );
    });
  });

  describe('/api/v1/catalog/products/:id/publish (PATCH)', () => {
    it('should publish a product successfully', async () => {
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Laptops' });

      const productRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({
          categoryId: categoryRes.body.data.id,
          name: 'MacBook Pro',
          skus: [{ skuCode: 'MBP-1', price: 1999, attributes: {} }],
        });

      const publishRes = await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productRes.body.data.id}/publish`)
        .expect(200);

      expect(publishRes.body.data.status).toBe('PUBLISHED');
    });

    it('should not publish a product without skus', async () => {
      const categoryRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .send({ name: 'Laptops' });

      const productRes = await request(app.getHttpServer())
        .post('/api/v1/catalog/products')
        .send({
          categoryId: categoryRes.body.data.id,
          name: 'Empty MacBook',
          skus: [],
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/products/${productRes.body.data.id}/publish`)
        .expect(400); // CAT-003 INVALID_PUBLISH
    });
  });
});
