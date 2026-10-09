import { Test, TestingModule } from '@nestjs/testing';
import { PrismaProductRepository } from './prisma-product.repository.js';
import { PrismaCategoryRepository } from './prisma-category.repository.js';
import { PrismaService, RedisService } from '@/core/index.js';
import { Product } from '../../../domain/entities/product.entity.js';
import { Category } from '../../../domain/entities/category.entity.js';
import { Price } from '../../../domain/value-objects/price.vo.js';
import { SkuAttributes } from '../../../domain/value-objects/sku-attributes.vo.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';
import { CatalogErrorCodes } from '@/core/index.js';

describe('PrismaProductRepository (Integration)', () => {
  let productRepo: PrismaProductRepository;
  let categoryRepo: PrismaCategoryRepository;
  let prismaService: PrismaService;
  let redisService: RedisService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaProductRepository,
        PrismaCategoryRepository,
        PrismaService,
        RedisService,
        CatalogMapper,
      ],
    }).compile();

    productRepo = module.get<PrismaProductRepository>(PrismaProductRepository);
    categoryRepo = module.get<PrismaCategoryRepository>(
      PrismaCategoryRepository,
    );
    prismaService = module.get<PrismaService>(PrismaService);
    redisService = module.get<RedisService>(RedisService);
  });

  beforeEach(async () => {
    // Clean up data
    await prismaService.sku.deleteMany();
    await prismaService.product.deleteMany();
    await prismaService.category.deleteMany();
    // Tests reuse fixed ids across runs, so a leftover cache entry from a
    // previous run could otherwise serve stale data instead of a miss.
    await redisService.getClient().flushdb();
  });

  afterAll(async () => {
    await prismaService.$disconnect();
    await redisService.getClient().quit();
  });

  it('should save a product with skus and find it by id', async () => {
    // Create a category first since product requires a valid category in DB for foreign key
    const category = Category.create('Laptops', null, 'cat_laptop');
    await categoryRepo.save(category);

    // Create a product
    const product = Product.create(
      {
        categoryId: 'cat_laptop',
        name: 'MacBook',
        description: 'A laptop',
        thumbnail: 'img.png',
      },
      'prod_macbook',
    );
    product.addSku({
      price: Price.create(1999),
      attributes: SkuAttributes.create({ ram: '16GB', color: 'Silver' }),
      skuCode: 'SKU-MB-16-SL',
    });
    product.addSku({
      price: Price.create(2499),
      attributes: SkuAttributes.create({ ram: '32GB', color: 'Space Gray' }),
      skuCode: 'SKU-MB-32-SG',
    });

    await productRepo.save(product);

    // Find by ID
    const foundProduct = await productRepo.findById('prod_macbook');

    expect(foundProduct).toBeDefined();
    expect(foundProduct?.id).toBe('prod_macbook');
    expect(foundProduct?.getProps().name).toBe('MacBook');
    expect(foundProduct?.getProps().skus).toHaveLength(2);
    expect(
      foundProduct?.getProps().skus.map((s) => s.getProps().skuCode),
    ).toContain('SKU-MB-16-SL');
  });

  it('should find products by categoryId and support pagination', async () => {
    const category = Category.create('Phones', null, 'cat_phone');
    await categoryRepo.save(category);

    const product1 = Product.create(
      { categoryId: 'cat_phone', name: 'iPhone 13' },
      'prod_13',
    );
    const product2 = Product.create(
      { categoryId: 'cat_phone', name: 'iPhone 14' },
      'prod_14',
    );
    const product3 = Product.create(
      { categoryId: 'cat_phone', name: 'iPhone 15' },
      'prod_15',
    );

    await productRepo.save(product1);
    await productRepo.save(product2);
    await productRepo.save(product3);

    // Find without cursor
    const result1 = await productRepo.findList({
      limit: 2,
      categoryPath: category.path,
    });
    expect(result1.data).toHaveLength(2);
    expect(result1.data.map((p) => p.id)).toEqual(['prod_13', 'prod_14']);
    expect(result1.meta.hasMore).toBe(true);
    expect(result1.meta.nextCursor).toBe('prod_14');

    // Find with cursor (Keyset pagination)
    const result2 = await productRepo.findList({
      cursor: 'prod_14',
      limit: 2,
      categoryPath: category.path,
    });
    expect(result2.data).toHaveLength(1);
    expect(result2.data[0].id).toBe('prod_15');
    expect(result2.meta.hasMore).toBe(false);
    expect(result2.meta.nextCursor).toBe(null);
  });

  describe('filtering by category path (the chosen category and everything below it)', () => {
    const saveCategory = async (id: string, parent: Category | null) => {
      const category = Category.create(`Category ${id}`, parent, id);
      await categoryRepo.save(category);
      return category;
    };

    const saveProduct = async (
      id: string,
      categoryId: string,
      options: { name?: string; price?: number } = {},
    ) => {
      const product = Product.create(
        { categoryId, name: options.name ?? `Product ${id}` },
        id,
      );
      if (options.price !== undefined) {
        product.addSku({
          price: Price.create(options.price),
          attributes: SkuAttributes.create({}),
          skuCode: `SKU-${id}`,
        });
      }
      await productRepo.save(product);
    };

    const idsOf = (result: { data: Product[] }) =>
      result.data.map((p) => p.id).sort();

    it('includes the products of every descendant (AC-16)', async () => {
      const electronics = await saveCategory('ele', null);
      const phones = await saveCategory('pho', electronics);
      const iphones = await saveCategory('iph', phones);
      const laptops = await saveCategory('lap', electronics);
      const fashion = await saveCategory('fas', null);
      await saveProduct('prod_in_electronics', electronics.id);
      await saveProduct('prod_in_phones', phones.id);
      await saveProduct('prod_in_iphones', iphones.id);
      await saveProduct('prod_in_laptops', laptops.id);
      await saveProduct('prod_in_fashion', fashion.id);

      const underElectronics = await productRepo.findList({
        limit: 20,
        categoryPath: electronics.path,
      });
      expect(idsOf(underElectronics)).toEqual([
        'prod_in_electronics',
        'prod_in_iphones',
        'prod_in_laptops',
        'prod_in_phones',
      ]);

      const underPhones = await productRepo.findList({
        limit: 20,
        categoryPath: phones.path,
      });
      expect(idsOf(underPhones)).toEqual(['prod_in_iphones', 'prod_in_phones']);

      const underFashion = await productRepo.findList({
        limit: 20,
        categoryPath: fashion.path,
      });
      expect(idsOf(underFashion)).toEqual(['prod_in_fashion']);
    });

    it('does not mix up categories whose ids start the same (AC-17)', async () => {
      const ten = await saveCategory('10', null);
      const hundred = await saveCategory('100', null);
      await saveProduct('prod_ten', ten.id);
      await saveProduct('prod_hundred', hundred.id);

      const result = await productRepo.findList({
        limit: 20,
        categoryPath: ten.path,
      });

      expect(idsOf(result)).toEqual(['prod_ten']);
    });

    it('combines with price, search and keyset pagination without repeating or skipping a product (AC-18)', async () => {
      const parent = await saveCategory('par', null);
      const childOne = await saveCategory('ch1', parent);
      const childTwo = await saveCategory('ch2', parent);
      const other = await saveCategory('oth', null);
      await saveProduct('prod_a1', parent.id, {
        name: 'alpha phone',
        price: 100,
      });
      await saveProduct('prod_a2', childOne.id, {
        name: 'beta phone',
        price: 200,
      });
      await saveProduct('prod_a3', childOne.id, {
        name: 'gamma laptop',
        price: 300,
      });
      await saveProduct('prod_a4', childTwo.id, {
        name: 'delta phone',
        price: 400,
      });
      await saveProduct('prod_a5', childTwo.id, {
        name: 'epsilon laptop',
        price: 500,
      });
      await saveProduct('prod_other', other.id, {
        name: 'zeta phone',
        price: 250,
      });

      // Walk the whole branch two products at a time
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await productRepo.findList({
          limit: 2,
          cursor,
          categoryPath: parent.path,
        });
        seen.push(...page.data.map((p) => p.id));
        cursor = page.meta.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      expect(seen).toEqual([
        'prod_a1',
        'prod_a2',
        'prod_a3',
        'prod_a4',
        'prod_a5',
      ]);
      expect(pages).toBe(3);

      const byPrice = await productRepo.findList({
        limit: 20,
        categoryPath: parent.path,
        minPrice: 200,
        maxPrice: 400,
      });
      expect(idsOf(byPrice)).toEqual(['prod_a2', 'prod_a3', 'prod_a4']);

      const bySearch = await productRepo.findList({
        limit: 20,
        categoryPath: childOne.path,
        search: 'phone',
      });
      expect(idsOf(bySearch)).toEqual(['prod_a2']);
    });
  });

  it('should full-text search products by name/description via the generated tsvector column', async () => {
    const category = Category.create('Search Cat', null, 'cat_search');
    await categoryRepo.save(category);

    const macbook = Product.create(
      {
        categoryId: 'cat_search',
        name: 'MacBook Pro',
        description: 'Apple laptop',
      },
      'prod_search_1',
    );
    const dell = Product.create(
      {
        categoryId: 'cat_search',
        name: 'Dell XPS',
        description: 'Windows laptop',
      },
      'prod_search_2',
    );
    await productRepo.save(macbook);
    await productRepo.save(dell);

    const byDescription = await productRepo.findList({
      limit: 10,
      search: 'apple',
    });
    expect(byDescription.data.map((p) => p.id)).toEqual(['prod_search_1']);

    const byName = await productRepo.findList({ limit: 10, search: 'dell' });
    expect(byName.data.map((p) => p.id)).toEqual(['prod_search_2']);

    const noMatch = await productRepo.findList({
      limit: 10,
      search: 'nonexistent-term',
    });
    expect(noMatch.data).toHaveLength(0);
  });

  it('should not delete a SKU added concurrently by another request', async () => {
    const category = Category.create('Shoes', null, 'cat_shoes');
    await categoryRepo.save(category);

    const initial = Product.create(
      { categoryId: 'cat_shoes', name: 'Sneaker' },
      'prod_sneaker',
    );
    initial.addSku({
      price: Price.create(100),
      attributes: SkuAttributes.create({ size: '40' }),
      skuCode: 'SNK-40',
    });
    await productRepo.save(initial);

    // Two requests load the same product before either one saves.
    const requestA = await productRepo.findById('prod_sneaker');
    const requestB = await productRepo.findById('prod_sneaker');

    // Request A adds a new SKU and saves first.
    requestA!.addSku({
      price: Price.create(120),
      attributes: SkuAttributes.create({ size: '41' }),
      skuCode: 'SNK-41',
    });
    await productRepo.save(requestA!);

    // Request B only updates the product's name — it never touched SKUs —
    // but saves from its now-stale in-memory snapshot (still version 1).
    // Optimistic concurrency now rejects this outright instead of letting
    // it through; the SKU-tracking fix alone only protected against the
    // stale write silently deleting SNK-41, not the stale write itself.
    requestB!.updateDetails('Sneaker Pro');
    await expect(productRepo.save(requestB!)).rejects.toMatchObject({
      code: CatalogErrorCodes.CONCURRENCY_CONFLICT.code,
    });

    const final = await productRepo.findById('prod_sneaker');
    const skuCodes = final?.getProps().skus.map((s) => s.getProps().skuCode);
    expect(skuCodes).toContain('SNK-40');
    expect(skuCodes).toContain('SNK-41');
  });

  it('should cache findById and invalidate the cache on save', async () => {
    const category = Category.create('Cache Cat', null, 'cat_cache');
    await categoryRepo.save(category);

    const product = Product.create(
      { categoryId: 'cat_cache', name: 'CacheTest' },
      'prod_cache',
    );
    await productRepo.save(product);

    // Populates the cache entry.
    const firstRead = await productRepo.findById('prod_cache');
    expect(firstRead?.name).toBe('CacheTest');

    // Mutate the row directly, bypassing the repository (and therefore its
    // cache invalidation), to prove the next read comes from cache.
    await prismaService.product.update({
      where: { id: 'prod_cache' },
      data: { name: 'ChangedBehindCache' },
    });
    const cachedRead = await productRepo.findById('prod_cache');
    expect(cachedRead?.name).toBe('CacheTest');

    // A real write through the repository must invalidate that entry.
    firstRead!.updateDetails('CacheInvalidated');
    await productRepo.save(firstRead!);
    const freshRead = await productRepo.findById('prod_cache');
    expect(freshRead?.name).toBe('CacheInvalidated');
  });

  it('should reject a save based on a stale version (optimistic concurrency)', async () => {
    const category = Category.create('Bags', null, 'cat_bags');
    await categoryRepo.save(category);

    const product = Product.create(
      { categoryId: 'cat_bags', name: 'Backpack' },
      'prod_backpack',
    );
    await productRepo.save(product);

    const staleCopy = await productRepo.findById('prod_backpack');
    const freshCopy = await productRepo.findById('prod_backpack');

    // Fresh copy saves first and bumps the row's version.
    freshCopy!.updateDetails('Backpack v2');
    await productRepo.save(freshCopy!);

    // Stale copy still thinks it's at the original version.
    staleCopy!.updateDetails('Backpack v3 (stale)');
    await expect(productRepo.save(staleCopy!)).rejects.toMatchObject({
      code: CatalogErrorCodes.CONCURRENCY_CONFLICT.code,
    });

    const finalProduct = await productRepo.findById('prod_backpack');
    expect(finalProduct?.name).toBe('Backpack v2');
  });
});
