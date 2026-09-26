import { Test, TestingModule } from '@nestjs/testing';
import { PrismaCategoryRepository } from './prisma-category.repository.js';
import { PrismaService, RedisService } from '@/core/index.js';
import { Category } from '../../../domain/entities/category.entity.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

describe('PrismaCategoryRepository (Integration)', () => {
  let repository: PrismaCategoryRepository;
  let prismaService: PrismaService;
  let redisService: RedisService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaCategoryRepository,
        PrismaService,
        RedisService,
        CatalogMapper,
      ],
    }).compile();

    repository = module.get<PrismaCategoryRepository>(PrismaCategoryRepository);
    prismaService = module.get<PrismaService>(PrismaService);
    redisService = module.get<RedisService>(RedisService);
  });

  beforeEach(async () => {
    // Dọn dẹp dữ liệu trước mỗi test
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

  it('should save and find a root category', async () => {
    const category = Category.create('Root', null, 'cat_root');
    await repository.save(category);

    const found = await prismaService.category.findUnique({
      where: { id: 'cat_root' },
    });
    expect(found).toBeDefined();
    expect(found?.name).toBe('Root');
    expect(found?.path).toBe('/cat_root/');
  });

  it('should find categories by parentId', async () => {
    const root = Category.create('Root', null, 'cat_root');
    const child1 = Category.create('Child 1', root, 'cat_child1');
    const child2 = Category.create('Child 2', root, 'cat_child2');

    await repository.save(root);
    await repository.save(child1);
    await repository.save(child2);

    const children = await repository.findByParentId('cat_root');
    expect(children.length).toBe(2);
    expect(children.map((c) => c.id)).toContain('cat_child1');
    expect(children.map((c) => c.id)).toContain('cat_child2');
  });

  it('should cache findById and invalidate the cache on save', async () => {
    const category = Category.create('CacheTest', null, 'cat_cache');
    await repository.save(category);

    const firstRead = await repository.findById('cat_cache');
    expect(firstRead?.name).toBe('CacheTest');

    // Mutate the row directly, bypassing the repository's invalidation.
    await prismaService.category.update({
      where: { id: 'cat_cache' },
      data: { name: 'ChangedBehindCache' },
    });
    const cachedRead = await repository.findById('cat_cache');
    expect(cachedRead?.name).toBe('CacheTest');

    firstRead!.updateDetails('CacheInvalidated');
    await repository.save(firstRead!);
    const freshRead = await repository.findById('cat_cache');
    expect(freshRead?.name).toBe('CacheInvalidated');
  });

  it('should invalidate cached descendants when a category subtree is moved', async () => {
    const root = Category.create('Root', null, 'cat_root');
    const child = Category.create('Child', root, 'cat_child');
    const grandchild = Category.create('Grandchild', child, 'cat_grandchild');
    const newParent = Category.create('New Parent', null, 'cat_new_parent');

    await repository.save(root);
    await repository.save(child);
    await repository.save(grandchild);
    await repository.save(newParent);

    // Populate cache entries for the whole subtree before the move.
    await repository.findById('cat_child');
    await repository.findById('cat_grandchild');

    const oldPath = child.path;
    child.moveTo(newParent);
    await repository.updatePathAndChildren(child, oldPath);

    const movedChild = await repository.findById('cat_child');
    const movedGrandchild = await repository.findById('cat_grandchild');
    expect(movedChild?.path).toBe('/cat_new_parent/cat_child/');
    expect(movedGrandchild?.path).toBe(
      '/cat_new_parent/cat_child/cat_grandchild/',
    );
  });
});
