import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { SearchProductsDto } from './search-products.dto.js';
import { FacetsQueryDto } from './facets-query.dto.js';
import { GetProductsDto } from './get-products.dto.js';
import { AdminGetProductsDto } from './admin-get-products.dto.js';
import { UpdateSkuPriceDto } from './update-sku-price.dto.js';
import { AddSkuDto } from './add-sku.dto.js';

// The pipe of the application, so the rules tested here are the ones the requests meet
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const parse = <T>(
  metatype: new () => T,
  value: Record<string, unknown>,
  type: 'query' | 'body' = 'query',
) => pipe.transform(value, { type, metatype }) as Promise<T>;
const refused = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ status: 400 });

describe('the query of the public product list', () => {
  it('takes nothing at all: newest first, 20 a page', async () => {
    const query = await parse(SearchProductsDto, {});

    expect(query).toMatchObject({ limit: 20, sort: 'newest' });
    expect(query.page).toBeUndefined();
    expect(query.cursor).toBeUndefined();
  });

  it('takes everything together', async () => {
    const query = await parse(SearchProductsDto, {
      page: '2',
      limit: '24',
      sort: 'price_asc',
      categoryId: '10',
      search: 'tai nghe',
      minPrice: '100000',
      maxPrice: '5000000',
      inStock: 'true',
      onSale: 'true',
    });

    expect(query).toMatchObject({
      page: 2,
      limit: 24,
      sort: 'price_asc',
      categoryId: '10',
      search: 'tai nghe',
      minPrice: 100000,
      maxPrice: 5000000,
      inStock: 'true',
      onSale: 'true',
    });
  });

  it.each(['newest', 'price_asc', 'price_desc', 'relevance'])(
    'accepts sort=%s',
    async (sort) => {
      expect((await parse(SearchProductsDto, { sort })).sort).toBe(sort);
    },
  );

  it.each(['cheapest', 'NEWEST', '', 'price', 'id'])(
    'refuses sort=%s',
    async (sort) => {
      await refused(parse(SearchProductsDto, { sort }));
    },
  );

  it.each(['false', 'abc', '1', 'TRUE', ''])(
    'refuses inStock=%s and onSale=%s (only true filters)',
    async (value) => {
      await refused(parse(SearchProductsDto, { inStock: value }));
      await refused(parse(SearchProductsDto, { onSale: value }));
    },
  );

  it.each([
    ['limit above 50', { limit: '51' }],
    ['limit 0', { limit: '0' }],
    ['page 0', { page: '0' }],
    ['a page that is not a whole number', { page: '1.5' }],
    ['a page that is not a number', { page: 'two' }],
    ['a price that is not a number', { minPrice: 'cheap' }],
    ['a status (customers only ever see what is on sale)', { status: 'DRAFT' }],
    ['a field it does not know', { userId: 'x' }],
    ['a very long search', { search: 'x'.repeat(201) }],
  ])('refuses %s', async (_label, value) => {
    await refused(parse(SearchProductsDto, value));
  });
});

describe('the query of the counts per category', () => {
  it('takes the parent and the filters', async () => {
    const query = await parse(FacetsQueryDto, {
      parentId: '10',
      search: 'phone',
      minPrice: '5',
      inStock: 'true',
    });

    expect(query).toMatchObject({
      parentId: '10',
      search: 'phone',
      minPrice: 5,
      inStock: 'true',
    });
  });

  it.each([
    ['a category', { categoryId: '10' }],
    ['a sort', { sort: 'price_asc' }],
    ['a page', { page: '1' }],
    ['a cursor', { cursor: 'x' }],
    ['a limit', { limit: '5' }],
    ['inStock=false', { inStock: 'false' }],
  ])('refuses %s', async (_label, value) => {
    await refused(parse(FacetsQueryDto, value));
  });
});

describe('the query of the admin list does not change', () => {
  it('takes what it took, and a status', async () => {
    const query = await parse(AdminGetProductsDto, {
      status: 'DRAFT',
      categoryId: '10',
      search: 'x',
      minPrice: '1',
      maxPrice: '9',
      cursor: 'p1',
      limit: '10',
    });

    expect(query).toMatchObject({
      status: 'DRAFT',
      categoryId: '10',
      cursor: 'p1',
      limit: 10,
    });
  });

  it.each([
    ['page', { page: '1' }],
    ['sort', { sort: 'price_asc' }],
    ['inStock', { inStock: 'true' }],
    ['onSale', { onSale: 'true' }],
  ])('refuses %s, which is only for the public list', async (_label, value) => {
    await refused(parse(AdminGetProductsDto, value));
    await refused(parse(GetProductsDto, value));
  });

  it('limit is at most 50, like every other list', async () => {
    expect((await parse(AdminGetProductsDto, { limit: '50' })).limit).toBe(50);
    await refused(parse(AdminGetProductsDto, { limit: '51' }));
  });
});

describe('the price before a discount in what the admin sends', () => {
  it('a SKU price can carry it as a number, as null (remove it), or not at all', async () => {
    expect(
      (
        await parse(
          UpdateSkuPriceDto,
          { price: 100, compareAtPrice: 150 },
          'body',
        )
      ).compareAtPrice,
    ).toBe(150);
    expect(
      (
        await parse(
          UpdateSkuPriceDto,
          { price: 100, compareAtPrice: null },
          'body',
        )
      ).compareAtPrice,
    ).toBeNull();
    expect(
      (await parse(UpdateSkuPriceDto, { price: 100 }, 'body')).compareAtPrice,
    ).toBeUndefined();
  });

  it.each([
    ['text', 'cheap'],
    ['negative', -1],
    ['a list', [1]],
  ])('refuses %s', async (_label, value) => {
    await refused(
      parse(UpdateSkuPriceDto, { price: 100, compareAtPrice: value }, 'body'),
    );
    await refused(
      parse(
        AddSkuDto,
        {
          skuCode: 'x',
          price: 1,
          attributes: { a: '1' },
          compareAtPrice: value,
        },
        'body',
      ),
    );
  });

  it('a new SKU can carry it', async () => {
    const dto = await parse(
      AddSkuDto,
      { skuCode: 'x', price: 100, attributes: { a: '1' }, compareAtPrice: 150 },
      'body',
    );

    expect(dto.compareAtPrice).toBe(150);
  });
});
