import { Test, TestingModule } from '@nestjs/testing';
import { PrismaCategoryRepository } from './prisma-category.repository.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { Category } from '../../../domain/entities/category.entity.js';
import { CatalogMapper } from '../mappers/catalog.mapper.js';

describe('PrismaCategoryRepository (Integration)', () => {
  let repository: PrismaCategoryRepository;
  let prismaService: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaCategoryRepository, PrismaService, CatalogMapper],
    }).compile();

    repository = module.get<PrismaCategoryRepository>(PrismaCategoryRepository);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Dọn dẹp dữ liệu trước mỗi test
    await prismaService.sku.deleteMany();
    await prismaService.product.deleteMany();
    await prismaService.category.deleteMany();
  });

  afterAll(async () => {
    await prismaService.$disconnect();
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
});
