import { Test, TestingModule } from '@nestjs/testing';
import { PrismaProductRepository } from './prisma-product.repository.js';
import { PrismaCategoryRepository } from './prisma-category.repository.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { Product } from '../../../domain/entities/product.entity.js';
import { Category } from '../../../domain/entities/category.entity.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

describe('PrismaProductRepository (Integration)', () => {
  let productRepo: PrismaProductRepository;
  let categoryRepo: PrismaCategoryRepository;
  let prismaService: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaProductRepository,
        PrismaCategoryRepository,
        PrismaService,
        CatalogMapper,
      ],
    }).compile();

    productRepo = module.get<PrismaProductRepository>(PrismaProductRepository);
    categoryRepo = module.get<PrismaCategoryRepository>(
      PrismaCategoryRepository,
    );
    prismaService = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Clean up data
    await prismaService.sku.deleteMany();
    await prismaService.product.deleteMany();
    await prismaService.category.deleteMany();
  });

  afterAll(async () => {
    await prismaService.$disconnect();
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
      price: 1999,
      attributes: { ram: '16GB', color: 'Silver' },
      skuCode: 'SKU-MB-16-SL',
    });
    product.addSku({
      price: 2499,
      attributes: { ram: '32GB', color: 'Space Gray' },
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
      categoryId: 'cat_phone',
    });
    expect(result1.data).toHaveLength(2);
    expect(result1.data.map((p) => p.id)).toEqual(['prod_13', 'prod_14']);
    expect(result1.meta.hasMore).toBe(true);
    expect(result1.meta.nextCursor).toBe('prod_14');

    // Find with cursor (Keyset pagination)
    const result2 = await productRepo.findList({
      cursor: 'prod_14',
      limit: 2,
      categoryId: 'cat_phone',
    });
    expect(result2.data).toHaveLength(1);
    expect(result2.data[0].id).toBe('prod_15');
    expect(result2.meta.hasMore).toBe(false);
    expect(result2.meta.nextCursor).toBe(null);
  });
});
