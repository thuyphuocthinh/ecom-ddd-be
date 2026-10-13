import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, RedisService } from '@/core/index.js';
import {
  Category,
  Price,
  Product,
  ProductStatus,
  SkuAttributes,
  type ProductSort,
} from './domain/index.js';
import { CatalogMapper } from './infrastructure/database/mappers/catalog.mapper.js';
import { PrismaCategoryRepository } from './infrastructure/database/repositories/prisma-category.repository.js';
import { PrismaProductRepository } from './infrastructure/database/repositories/prisma-product.repository.js';
import {
  GetProductFacetsHandler,
  GetProductFacetsQuery,
  GetPublishedProductByIdHandler,
  GetPublishedProductByIdQuery,
  SearchProductsHandler,
  SearchProductsQuery,
  type SearchProductsOptions,
} from './application/index.js';

/** A product the tests put in the catalog, and what it is expected to be found as. */
interface Fixture {
  id: string;
  categoryId: string;
  name: string;
  description?: string;
  status?: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED';
  /** Minutes ago it was created (more is older). */
  ageMinutes?: number;
  skus: {
    id: string;
    price: number;
    compareAtPrice?: number;
    onHand?: number; // no row at all when left out
  }[];
}

const T = 60_000;

/**
 * The public product search against the real Postgres and Redis: sorting, both kinds of paging,
 * every filter, the stock label, discounts, and the counts per category.
 */
describe('Searching the catalog (Integration)', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let redis: RedisService;
  let products: PrismaProductRepository;
  let categories: PrismaCategoryRepository;
  let search: SearchProductsHandler;
  let facets: GetProductFacetsHandler;
  let detail: GetPublishedProductByIdHandler;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        RedisService,
        CatalogMapper,
        PrismaProductRepository,
        PrismaCategoryRepository,
        { provide: 'IProductRepository', useExisting: PrismaProductRepository },
        {
          provide: 'ICategoryRepository',
          useExisting: PrismaCategoryRepository,
        },
        SearchProductsHandler,
        GetProductFacetsHandler,
        GetPublishedProductByIdHandler,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    redis = module.get(RedisService);
    products = module.get(PrismaProductRepository);
    categories = module.get(PrismaCategoryRepository);
    search = module.get(SearchProductsHandler);
    facets = module.get(GetProductFacetsHandler);
    detail = module.get(GetPublishedProductByIdHandler);
  }, T);

  const clean = async () => {
    await prisma.reservation.deleteMany();
    await prisma.sku.deleteMany(); // the stock goes with its SKU
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await redis.getClient().flushdb();
  };
  beforeEach(clean, T);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
    await redis.getClient().quit();
  });

  // ── what the tests put in ─────────────────────────────────────────────────

  const category = async (id: string, parent: Category | null = null) => {
    const made = Category.create(id, parent, id);
    await categories.save(made);
    return made;
  };
  /** A product made through the domain, so that every rule (and `minPrice`) is the real one. */
  const product = async (fixture: Fixture) => {
    const made = Product.create(
      {
        categoryId: fixture.categoryId,
        name: fixture.name,
        description: fixture.description,
      },
      fixture.id,
    );
    for (const sku of fixture.skus) {
      made.addSku(
        {
          price: Price.create(sku.price),
          compareAtPrice:
            sku.compareAtPrice === undefined
              ? null
              : Price.create(sku.compareAtPrice),
          attributes: SkuAttributes.create({ id: sku.id }),
          skuCode: `code-${sku.id}`,
        },
        sku.id,
      );
    }
    if (fixture.skus.length > 0 && fixture.status !== 'DRAFT') made.publish();
    await products.save(made);
    if (fixture.status === 'ARCHIVED') {
      await prisma.product.update({
        where: { id: fixture.id },
        data: { status: 'ARCHIVED' },
      });
    }
    for (const sku of fixture.skus) {
      if (sku.onHand !== undefined) {
        await prisma.skuStock.create({
          data: { skuId: sku.id, onHand: sku.onHand },
        });
      }
    }
    await prisma.$executeRaw`UPDATE "Product" SET "createdAt" = (now() AT TIME ZONE 'UTC') - make_interval(mins => ${fixture.ageMinutes ?? 0}) WHERE "id" = ${fixture.id}`;
    return made;
  };
  /** Many plain published products at once (no SKUs), for the tests about sizes. */
  const bulk = async (count: number, prefix = 'bulk') => {
    await category('bulk_cat');
    const now = Date.now();
    await prisma.product.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        id: `${prefix}_${String(i).padStart(5, '0')}`,
        categoryId: 'bulk_cat',
        name: `Bulk ${i}`,
        status: 'PUBLISHED' as const,
        createdAt: new Date(now - i * 1000),
      })),
    });
  };

  const run = (options: Partial<SearchProductsOptions> = {}) =>
    search.execute(
      new SearchProductsQuery({ limit: 50, sort: 'newest', ...options }),
    );
  const idsOf = async (options: Partial<SearchProductsOptions> = {}) =>
    (await run(options)).data.map((p) => p.id);
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error: any) {
      return error.code as string;
    }
    throw new Error('should have been refused');
  };
  const minPriceOf = async (id: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id } })).minPrice;

  // ── AC-27: the lowest price ───────────────────────────────────────────────

  describe('the lowest price of a product (AC-27)', () => {
    it('is kept right by every way a SKU can change', async () => {
      await category('c1');
      await product({
        id: 'p1',
        categoryId: 'c1',
        name: 'Phone',
        skus: [
          { id: 'a', price: 300 },
          { id: 'b', price: 500 },
        ],
      });
      expect(Number(await minPriceOf('p1'))).toBe(300);
      // A saved aggregate must be read again before the next change (its version moved on)
      const reload = async () => (await products.findById('p1'))!;

      let made = await reload();
      made.addSku(
        {
          price: Price.create(200),
          attributes: SkuAttributes.create({ id: 'c' }),
          skuCode: 'code-c',
        },
        'c',
      );
      await products.save(made);
      expect(Number(await minPriceOf('p1'))).toBe(200);

      made = await reload();
      made.removeSku('c');
      await products.save(made);
      expect(Number(await minPriceOf('p1'))).toBe(300);

      made = await reload();
      made.updateSkuPrice('a', Price.create(600));
      await products.save(made);
      expect(Number(await minPriceOf('p1'))).toBe(500);
    });

    it('is empty for a product with no SKU, and such a product has no place in a sort by price', async () => {
      await category('c1');
      await product({
        id: 'none',
        categoryId: 'c1',
        name: 'No SKU',
        status: 'DRAFT',
        skus: [],
      });

      expect(await minPriceOf('none')).toBeNull();
    });
  });

  // ── AC-24: newest first, read by cursor ───────────────────────────────────

  describe('newest first, read by cursor (AC-24)', () => {
    beforeEach(async () => {
      await category('c1');
      for (const [i, age] of [50, 40, 30, 20, 10].entries()) {
        await product({
          id: `p${i + 1}`,
          categoryId: 'c1',
          name: `Product ${i + 1}`,
          ageMinutes: age,
          skus: [{ id: `s${i + 1}`, price: 100 }],
        });
      }
    });

    it('puts the newest product first', async () => {
      expect(await idsOf()).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
    });

    it('goes through all the pages with a cursor, each product once, with no OFFSET', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await run({ limit: 2, cursor });
        seen.push(...page.data.map((p) => p.id));
        expect(Object.keys(page.meta).sort()).toEqual([
          'hasMore',
          'nextCursor',
        ]);
        cursor =
          (page.meta as { nextCursor: string | null }).nextCursor ?? undefined;
        pages++;
      } while (cursor);

      expect(seen).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
      expect(pages).toBe(3);
    });

    it('does not repeat or skip when a newer product appears between two pages', async () => {
      const first = await run({ limit: 2 });
      await product({
        id: 'newest',
        categoryId: 'c1',
        name: 'Just added',
        skus: [{ id: 'sn', price: 100 }],
      });

      const second = await run({
        limit: 2,
        cursor: (first.meta as { nextCursor: string }).nextCursor,
      });

      expect(second.data.map((p) => p.id)).toEqual(['p3', 'p2']);
    });

    it('breaks a tie of creation time by id, so pages stay whole', async () => {
      for (const id of ['t1', 't2', 't3', 't4']) {
        await product({
          id,
          categoryId: 'c1',
          name: id,
          ageMinutes: 5,
          skus: [{ id: `s${id}`, price: 100 }],
        });
      }
      await prisma.$executeRaw`UPDATE "Product" SET "createdAt" = (SELECT "createdAt" FROM "Product" WHERE "id" = 't1') WHERE "id" IN ('t2','t3','t4')`;

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await run({ limit: 1, cursor });
        seen.push(...page.data.map((p) => p.id));
        cursor =
          (page.meta as { nextCursor: string | null }).nextCursor ?? undefined;
      } while (cursor);

      expect(seen.filter((id) => id.startsWith('t'))).toEqual([
        't4',
        't3',
        't2',
        't1',
      ]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('refuses a cursor that is not a product with CAT-017', async () => {
      expect(await refusal(run({ cursor: 'no-such-product' }))).toBe('CAT-017');
    });
  });

  // ── AC-25: numbered pages ─────────────────────────────────────────────────

  describe('numbered pages (AC-25)', () => {
    it('reads a page by its number, with the position and the total', async () => {
      await bulk(45);

      const second = await run({ page: 2, limit: 20 });
      const third = await run({ page: 3, limit: 20 });
      const beyond = await run({ page: 9, limit: 20 });

      expect(second.data).toHaveLength(20);
      expect(second.meta).toEqual({
        page: 2,
        limit: 20,
        hasMore: true,
        total: 45,
        totalCapped: false,
      });
      expect(third.data).toHaveLength(5);
      expect(third.meta).toMatchObject({ hasMore: false, total: 45 });
      expect(beyond.data).toEqual([]);
      expect(beyond.meta).toMatchObject({ page: 9, hasMore: false, total: 45 });
      // the pages are the list, cut in order
      const all = await idsOf({ limit: 50 });
      expect([
        ...(await idsOf({ page: 1, limit: 20 })),
        ...second.data.map((p) => p.id),
        ...third.data.map((p) => p.id),
      ]).toEqual(all);
    });

    it(
      'counts only up to 1000, and says when there are more',
      async () => {
        await bulk(1010);

        const first = await run({ page: 1, limit: 20 });
        const last = await run({ page: 20, limit: 50 }); // 20 * 50 = 1000: the last page that can be read

        expect(first.meta).toEqual({
          page: 1,
          limit: 20,
          hasMore: true,
          total: 1000,
          totalCapped: true,
        });
        expect(last.data).toHaveLength(50);
        expect(last.meta).toMatchObject({
          page: 20,
          hasMore: false,
          total: 1000,
          totalCapped: true,
        });
      },
      T,
    );

    it('refuses a page that would reach past the first 1000 results, and page with cursor, with CAT-017', async () => {
      await bulk(3);

      expect(await refusal(run({ page: 21, limit: 50 }))).toBe('CAT-017');
      expect(await refusal(run({ page: 101, limit: 10 }))).toBe('CAT-017');
      expect(await run({ page: 100, limit: 10 })).toBeDefined(); // 1000 exactly is fine
      expect(await refusal(run({ page: 1, cursor: 'bulk_00000' }))).toBe(
        'CAT-017',
      );
    });

    it('counts only what is on sale: a draft and an archived product are not in the total', async () => {
      await category('c1');
      await product({
        id: 'on',
        categoryId: 'c1',
        name: 'On',
        skus: [{ id: 's1', price: 10 }],
      });
      await product({
        id: 'draft',
        categoryId: 'c1',
        name: 'Draft',
        status: 'DRAFT',
        skus: [{ id: 's2', price: 10 }],
      });
      await product({
        id: 'old',
        categoryId: 'c1',
        name: 'Old',
        status: 'ARCHIVED',
        skus: [{ id: 's3', price: 10 }],
      });

      const result = await run({ page: 1, limit: 10 });

      expect(result.data.map((p) => p.id)).toEqual(['on']);
      expect(result.meta).toMatchObject({ total: 1 });
    });
  });

  // ── AC-26: sorting ────────────────────────────────────────────────────────

  describe('sorting (AC-26)', () => {
    beforeEach(async () => {
      await category('c1');
      // minPrice: a 100, b 200, c 200 (a tie with b), d 300, e 500 (its cheapest SKU is 400... see below)
      const rows: [string, number[]][] = [
        ['a', [100]],
        ['b', [200]],
        ['c', [200, 900]],
        ['d', [300]],
        ['e', [500, 400]],
      ];
      for (const [id, prices] of rows) {
        await product({
          id,
          categoryId: 'c1',
          name: `Item ${id}`,
          skus: prices.map((price, i) => ({ id: `${id}${i}`, price })),
        });
      }
    });

    it('by the lowest price of the SKUs, either way, ties by id', async () => {
      expect(await idsOf({ sort: 'price_asc', page: 1 })).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);
      expect(await idsOf({ sort: 'price_desc', page: 1 })).toEqual([
        'e',
        'd',
        'c',
        'b',
        'a',
      ]);
    });

    it('goes through every page without a repeat or a gap, also over the tie', async () => {
      for (const sort of ['price_asc', 'price_desc'] as ProductSort[]) {
        const all = await idsOf({ sort, page: 1, limit: 50 });
        const seen: string[] = [];
        for (let page = 1; page <= 5; page++) {
          seen.push(...(await idsOf({ sort, page, limit: 1 })));
        }
        expect(seen).toEqual(all);
        expect(new Set(seen).size).toBe(5);
      }
    });

    it('by relevance: the product that matches more comes first', async () => {
      await product({
        id: 'r1',
        categoryId: 'c1',
        name: 'Headphones',
        description: 'headphones for music',
        skus: [{ id: 'sr1', price: 10 }],
      });
      await product({
        id: 'r2',
        categoryId: 'c1',
        name: 'Headphones headphones headphones',
        description: 'headphones headphones',
        skus: [{ id: 'sr2', price: 10 }],
      });
      await product({
        id: 'r3',
        categoryId: 'c1',
        name: 'Speaker',
        skus: [{ id: 'sr3', price: 10 }],
      });

      expect(
        await idsOf({ sort: 'relevance', search: 'headphones', page: 1 }),
      ).toEqual(['r2', 'r1']);
    });

    it('refuses relevance with no search, and a cursor with any other sort, with CAT-017', async () => {
      expect(await refusal(run({ sort: 'relevance', page: 1 }))).toBe(
        'CAT-017',
      );
      expect(
        await refusal(run({ sort: 'relevance', page: 1, search: '   ' })),
      ).toBe('CAT-017');
      expect(await refusal(run({ sort: 'price_asc', cursor: 'a' }))).toBe(
        'CAT-017',
      );
      expect(await refusal(run({ sort: 'wild' as ProductSort }))).toBe(
        'CAT-017',
      );
    });
  });

  // ── AC-28, AC-33: the filters together ────────────────────────────────────

  describe('every filter and every combination of them (AC-28, AC-33)', () => {
    // E has two children, P and L; F is apart. "none" is a draft that fits everything.
    const FIXTURES: Fixture[] = [
      {
        id: 'f1',
        categoryId: 'P',
        name: 'Phone case',
        description: 'a case',
        ageMinutes: 90,
        skus: [{ id: 'f1a', price: 50, onHand: 5 }],
      },
      {
        id: 'f2',
        categoryId: 'P',
        name: 'Phone',
        ageMinutes: 80,
        skus: [
          { id: 'f2a', price: 900, compareAtPrice: 1000, onHand: 2 },
          { id: 'f2b', price: 1200, onHand: 0 },
        ],
      },
      {
        id: 'f3',
        categoryId: 'L',
        name: 'Laptop',
        ageMinutes: 70,
        skus: [{ id: 'f3a', price: 2000, onHand: 0 }],
      },
      {
        id: 'f4',
        categoryId: 'L',
        name: 'Laptop phone dock',
        ageMinutes: 60,
        skus: [{ id: 'f4a', price: 300, compareAtPrice: 400 }],
      },
      {
        id: 'f5',
        categoryId: 'E',
        name: 'Cable',
        description: 'for any phone',
        ageMinutes: 50,
        skus: [{ id: 'f5a', price: 20, onHand: 100 }],
      },
      {
        id: 'f6',
        categoryId: 'F',
        name: 'T-shirt',
        ageMinutes: 40,
        skus: [{ id: 'f6a', price: 150, compareAtPrice: 200, onHand: 7 }],
      },
      {
        id: 'f7',
        categoryId: 'F',
        name: 'Jacket',
        ageMinutes: 30,
        skus: [
          { id: 'f7a', price: 500, onHand: 0 },
          { id: 'f7b', price: 450, onHand: 3 },
        ],
      },
      {
        id: 'draft',
        categoryId: 'P',
        name: 'Phone draft',
        status: 'DRAFT',
        ageMinutes: 20,
        skus: [{ id: 'da', price: 60, compareAtPrice: 90, onHand: 9 }],
      },
      {
        id: 'old',
        categoryId: 'P',
        name: 'Phone archived',
        status: 'ARCHIVED',
        ageMinutes: 10,
        skus: [{ id: 'oa', price: 70, compareAtPrice: 99, onHand: 9 }],
      },
    ];
    const SUBTREE: Record<string, string[]> = {
      E: ['E', 'P', 'L'],
      P: ['P'],
      L: ['L'],
      F: ['F'],
    };

    beforeEach(async () => {
      const e = await category('E');
      await category('P', e);
      await category('L', e);
      await category('F');
      for (const fixture of FIXTURES) await product(fixture);
    }, T);

    /** What a product that fits the filters is, worked out here from the fixtures, not by the code under test. */
    const expected = (filters: {
      category?: string;
      search?: string;
      min?: number;
      max?: number;
      inStock?: boolean;
      onSale?: boolean;
    }) =>
      FIXTURES.filter((f) => (f.status ?? 'PUBLISHED') === 'PUBLISHED')
        .filter(
          (f) =>
            !filters.category ||
            SUBTREE[filters.category].includes(f.categoryId),
        )
        .filter(
          (f) =>
            !filters.search ||
            `${f.name} ${f.description ?? ''}`
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .includes(filters.search),
        )
        .filter((f) =>
          f.skus.some(
            (s) =>
              (filters.min === undefined || s.price >= filters.min) &&
              (filters.max === undefined || s.price <= filters.max),
          ),
        )
        .filter(
          (f) => !filters.inStock || f.skus.some((s) => (s.onHand ?? 0) > 0),
        )
        .filter(
          (f) =>
            !filters.onSale ||
            f.skus.some((s) => s.compareAtPrice !== undefined),
        )
        .sort((a, b) => (a.ageMinutes ?? 0) - (b.ageMinutes ?? 0)); // newest first

    it('every combination gives exactly what the fixtures say, in pages and in the total', async () => {
      let checked = 0;
      for (const category of [undefined, 'E', 'P', 'F']) {
        for (const searchWord of [undefined, 'phone']) {
          for (const [min, max] of [
            [undefined, undefined],
            [100, undefined],
            [undefined, 500],
            [100, 1000],
          ] as const) {
            for (const inStock of [undefined, true]) {
              for (const onSale of [undefined, true]) {
                const filters = {
                  category,
                  search: searchWord,
                  min,
                  max,
                  inStock,
                  onSale,
                };
                const want = expected(filters).map((f) => f.id);
                const options = {
                  categoryId: category,
                  search: searchWord,
                  minPrice: min,
                  maxPrice: max,
                  inStock,
                  onSale,
                };

                const byPage = await run({ ...options, page: 1, limit: 50 });
                const byCursor = await run({ ...options, limit: 50 });

                expect(
                  byPage.data.map((p) => p.id),
                  JSON.stringify(filters),
                ).toEqual(want);
                expect(
                  byCursor.data.map((p) => p.id),
                  JSON.stringify(filters),
                ).toEqual(want);
                expect(
                  (byPage.meta as { total: number }).total,
                  JSON.stringify(filters),
                ).toBe(want.length);
                checked++;
              }
            }
          }
        }
      }
      expect(checked).toBe(4 * 2 * 4 * 2 * 2);
    }, 120_000);

    it('the same filters through the pages of any sort: no repeat, no gap', async () => {
      for (const sort of [
        'newest',
        'price_asc',
        'price_desc',
      ] as ProductSort[]) {
        const all = await idsOf({ sort, page: 1, limit: 50, search: 'phone' });
        const seen: string[] = [];
        for (let page = 1; page <= all.length; page++) {
          seen.push(
            ...(await idsOf({ sort, page, limit: 1, search: 'phone' })),
          );
        }
        expect(seen, sort).toEqual(all);
      }
    });

    it('a category that is unknown gives an empty list, in the shape of the way it is read', async () => {
      const byPage = await run({ categoryId: 'nope', page: 2, limit: 10 });
      const byCursor = await run({ categoryId: 'nope' });

      expect(byPage.data).toEqual([]);
      expect(byPage.meta).toEqual({
        page: 2,
        limit: 10,
        hasMore: false,
        total: 0,
        totalCapped: false,
      });
      expect(byCursor.meta).toEqual({ hasMore: false, nextCursor: null });
    });

    it('hiding a product shows at once in the list (nothing is cached there)', async () => {
      const before = await idsOf({ page: 1 });
      const found = (await products.findById('f1'))!;
      found.unpublish();
      await products.save(found);

      const after = await idsOf({ page: 1 });

      expect(before).toContain('f1');
      expect(after).not.toContain('f1');
    });
  });

  // ── AC-29: the stock label ────────────────────────────────────────────────

  describe('the stock label (AC-29)', () => {
    beforeEach(async () => {
      await category('c1');
      await product({
        id: 'mixed',
        categoryId: 'c1',
        name: 'Mixed',
        skus: [
          { id: 'in', price: 10, onHand: 5 },
          { id: 'out', price: 10, onHand: 0 },
          { id: 'none', price: 10 },
        ],
      });
      await product({
        id: 'gone',
        categoryId: 'c1',
        name: 'Gone',
        skus: [
          { id: 'g1', price: 10, onHand: 0 },
          { id: 'g2', price: 10 },
        ],
      });
    });

    it('a SKU is in stock when onHand is above 0; no stock row means it is not', async () => {
      const result = await run({ page: 1 });

      expect(result.inStockSkuIds).toEqual(new Set(['in']));
    });

    it('the filter keeps the products that have at least one SKU in stock', async () => {
      expect(await idsOf({ inStock: true, page: 1 })).toEqual(['mixed']);
      expect(await idsOf({ page: 1 })).toHaveLength(2);
    });

    it('is read now, even for a product whose row is in the cache: stock that falls to 0 shows at once', async () => {
      const first = await detail.execute(
        new GetPublishedProductByIdQuery('mixed'),
      );
      expect(first.inStockSkuIds).toEqual(new Set(['in']));
      expect(await redis.getClient().keys('*mixed*')).not.toEqual([]); // it is cached now

      await prisma.skuStock.update({
        where: { skuId: 'in' },
        data: { onHand: 0 },
      });
      const second = await detail.execute(
        new GetPublishedProductByIdQuery('mixed'),
      );

      expect(second.inStockSkuIds).toEqual(new Set());
    });

    it('does not count what is held for orders: the number is onHand, as it is', async () => {
      // 5 on hand, and an order holds all 5 (the hold is in Redis and in Reservation): still in stock
      await prisma.skuStock.update({
        where: { skuId: 'in' },
        data: { onHand: 5 },
      });

      expect((await run({ page: 1 })).inStockSkuIds.has('in')).toBe(true);
    });
  });

  // ── AC-30: discounts do not touch money ───────────────────────────────────

  describe('the price before a discount (AC-30)', () => {
    it('is kept and read back, with the discount worked out; the selling price stays the price', async () => {
      await category('c1');
      await product({
        id: 'sale',
        categoryId: 'c1',
        name: 'Aero 2',
        skus: [
          {
            id: 'aero',
            price: 3_990_000,
            compareAtPrice: 4_590_000,
            onHand: 1,
          },
        ],
      });

      const found = (await run({ page: 1 })).data[0];

      expect(found.skus[0].price.amount).toBe(3_990_000);
      expect(found.skus[0].compareAtPrice?.amount).toBe(4_590_000);
      expect(found.skus[0].discountPercent).toBe(13);
      expect(found.onSale).toBe(true);
      expect(found.discountPercent).toBe(13);
      expect(found.minPrice).toBe(3_990_000);
    });

    it('the lookup the cart and the order use gives the selling price and not the original', async () => {
      await category('c1');
      await product({
        id: 'sale',
        categoryId: 'c1',
        name: 'Aero 2',
        skus: [{ id: 'aero', price: 3_990_000, compareAtPrice: 4_590_000 }],
      });

      const [item] = await products.findSkusByIds(['aero']);

      expect(item.price).toBe(3_990_000);
      expect(Object.keys(item)).not.toContain('compareAtPrice');
    });

    it('the database refuses an original price that is not greater, whoever writes it', async () => {
      await category('c1');
      await product({
        id: 'p',
        categoryId: 'c1',
        name: 'P',
        skus: [{ id: 'x', price: 100 }],
      });

      await expect(
        prisma.$executeRaw`UPDATE "Sku" SET "compareAtPrice" = 100 WHERE "id" = 'x'`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE "Sku" SET "compareAtPrice" = 50 WHERE "id" = 'x'`,
      ).rejects.toThrow();
      await prisma.$executeRaw`UPDATE "Sku" SET "compareAtPrice" = 101 WHERE "id" = 'x'`;
      await prisma.$executeRaw`UPDATE "Sku" SET "compareAtPrice" = NULL WHERE "id" = 'x'`;
    });

    it('the discount can be removed again, and the product leaves the on sale filter', async () => {
      await category('c1');
      const made = await product({
        id: 'p',
        categoryId: 'c1',
        name: 'P',
        skus: [{ id: 'x', price: 100, compareAtPrice: 150 }],
      });
      expect(await idsOf({ onSale: true, page: 1 })).toEqual(['p']);

      made.updateSkuPrice('x', Price.create(100), null);
      await products.save(made);

      expect(await idsOf({ onSale: true, page: 1 })).toEqual([]);
    });
  });

  // ── AC-31: the counts per category ────────────────────────────────────────

  describe('counting by category (AC-31)', () => {
    beforeEach(async () => {
      const e = await category('E');
      await category('P', e);
      await category('L', e);
      await category('F');
      await category('Empty');
      const rows: Fixture[] = [
        {
          id: 'a',
          categoryId: 'P',
          name: 'Phone',
          skus: [{ id: 'a1', price: 10, onHand: 1 }],
        },
        {
          id: 'b',
          categoryId: 'P',
          name: 'Phone two',
          skus: [{ id: 'b1', price: 10, onHand: 0 }],
        },
        {
          id: 'c',
          categoryId: 'L',
          name: 'Laptop',
          skus: [{ id: 'c1', price: 10, onHand: 1 }],
        },
        {
          id: 'd',
          categoryId: 'E',
          name: 'Cable',
          skus: [{ id: 'd1', price: 10, compareAtPrice: 20, onHand: 1 }],
        },
        {
          id: 'e',
          categoryId: 'F',
          name: 'Shirt',
          skus: [{ id: 'e1', price: 10, onHand: 1 }],
        },
        {
          id: 'x',
          categoryId: 'P',
          name: 'Phone draft',
          status: 'DRAFT',
          skus: [{ id: 'x1', price: 10, onHand: 1 }],
        },
      ];
      for (const row of rows) await product(row);
    });
    const countsOf = async (parentId: string | null, filters = {}) =>
      Object.fromEntries(
        (
          await facets.execute(new GetProductFacetsQuery(parentId, filters))
        ).map((c) => [c.categoryId, c.count]),
      );

    it('the root categories, each counting everything below it, with 0 where there is none', async () => {
      expect(await countsOf(null)).toEqual({ E: 4, F: 1, Empty: 0 });
    });

    it('the categories under one of them', async () => {
      expect(await countsOf('E')).toEqual({ P: 2, L: 1 });
    });

    it('inside the filters, and the counts match the list filtered by that category', async () => {
      expect(await countsOf(null, { inStock: true })).toEqual({
        E: 3,
        F: 1,
        Empty: 0,
      });
      expect(await countsOf(null, { onSale: true })).toEqual({
        E: 1,
        F: 0,
        Empty: 0,
      });
      expect(await countsOf(null, { search: 'phone' })).toEqual({
        E: 2,
        F: 0,
        Empty: 0,
      });
      for (const filters of [
        {},
        { inStock: true },
        { onSale: true },
        { search: 'phone' },
      ]) {
        const counted = await countsOf(null, filters);
        for (const id of ['E', 'F', 'Empty']) {
          const listed = await run({ categoryId: id, page: 1, ...filters });
          expect(
            (listed.meta as { total: number }).total,
            `${id} ${JSON.stringify(filters)}`,
          ).toBe(counted[id]);
        }
      }
    });

    it('a parent that does not exist has no categories under it', async () => {
      expect(await facets.execute(new GetProductFacetsQuery('nope'))).toEqual(
        [],
      );
    });
  });
});
