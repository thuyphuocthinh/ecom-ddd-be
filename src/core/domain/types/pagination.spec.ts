import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  toCursorPage,
  toPage,
} from './pagination.js';
import {
  PaginationQueryDto,
  WithCursorPagination,
  WithPageNumber,
} from '../../http/dtos/pagination-query.dto.js';

const row = (id: number) => ({ id: `row-${id}` });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));
const idOf = (r: { id: string }) => r.id;

describe('toCursorPage', () => {
  it('cuts the extra row off and points the cursor at the last row that is kept', () => {
    const page = toCursorPage(rows(4), 3, idOf); // asked for limit + 1 = 4

    expect(page.data).toEqual(rows(3));
    expect(page.meta).toEqual({ hasMore: true, nextCursor: 'row-3' });
  });

  it('has no next page when the database found no more than the limit', () => {
    expect(toCursorPage(rows(3), 3, idOf)).toEqual({
      data: rows(3),
      meta: { hasMore: false, nextCursor: null },
    });
    expect(toCursorPage(rows(2), 3, idOf).meta).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });

  it('is an empty last page when there are no rows', () => {
    expect(toCursorPage([], 20, idOf)).toEqual({
      data: [],
      meta: { hasMore: false, nextCursor: null },
    });
  });

  it('works with a limit of 1', () => {
    const page = toCursorPage(rows(2), 1, idOf);

    expect(page.data).toEqual([row(1)]);
    expect(page.meta).toEqual({ hasMore: true, nextCursor: 'row-1' });
  });

  it('does not change the rows it was given', () => {
    const given = rows(4);

    toCursorPage(given, 3, idOf);

    expect(given).toHaveLength(4);
  });
});

describe('toPage', () => {
  const position = (over = {}) => ({
    page: 1,
    limit: 20,
    total: 45,
    totalCapped: false,
    ...over,
  });

  it('says there is more while the pages read so far do not reach the total', () => {
    expect(toPage(rows(20), position({ page: 1 })).meta.hasMore).toBe(true);
    expect(toPage(rows(20), position({ page: 2 })).meta.hasMore).toBe(true);
    expect(toPage(rows(5), position({ page: 3 })).meta.hasMore).toBe(false);
  });

  it('has no more when the page reaches exactly the total', () => {
    expect(
      toPage(rows(20), position({ page: 2, total: 40 })).meta.hasMore,
    ).toBe(false);
  });

  it('keeps the position and the capped total as they are given', () => {
    expect(
      toPage(rows(50), { page: 20, limit: 50, total: 1000, totalCapped: true })
        .meta,
    ).toEqual({
      page: 20,
      limit: 50,
      hasMore: false,
      total: 1000,
      totalCapped: true,
    });
  });

  it('a page past the end is empty with no more', () => {
    const page = toPage([], position({ page: 9 }));

    expect(page.data).toEqual([]);
    expect(page.meta.hasMore).toBe(false);
  });

  it('a capped total keeps saying there is more until the window is read', () => {
    expect(
      toPage(rows(20), {
        page: 1,
        limit: 20,
        total: 1000,
        totalCapped: true,
      }).meta.hasMore,
    ).toBe(true);
  });
});

describe('the page size', () => {
  it('is 20 unless asked, and at most 50', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect(MAX_PAGE_SIZE).toBe(50);
  });
});

describe('the query fields of a list', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const parse = <T>(metatype: new () => T, query: Record<string, unknown>) =>
    pipe.transform(query, { type: 'query', metatype }) as Promise<T>;
  const refused = (promise: Promise<unknown>) =>
    expect(promise).rejects.toMatchObject({ status: 400 });

  it('PaginationQueryDto defaults to 20 and has no cursor', async () => {
    const query = await parse(PaginationQueryDto, {});

    expect(query.limit).toBe(20);
    expect(query.cursor).toBeUndefined();
  });

  it.each([1, 20, 50])('accepts limit %s', async (limit) => {
    expect(
      (await parse(PaginationQueryDto, { limit: String(limit) })).limit,
    ).toBe(limit);
  });

  it.each(['0', '-1', '51', '1000', '1.5', 'abc', ''])(
    'refuses limit %s',
    async (limit) => {
      await refused(parse(PaginationQueryDto, { limit }));
    },
  );

  it('refuses a cursor that is too long', async () => {
    await refused(parse(PaginationQueryDto, { cursor: 'x'.repeat(101) }));
  });

  it('adds limit and cursor to another query class, with the same checks', async () => {
    class Filters {}
    class WithFilters extends WithCursorPagination(Filters) {}

    const query = await parse(WithFilters, { limit: '5', cursor: 'abc' });

    expect(query).toMatchObject({ limit: 5, cursor: 'abc' });
    await refused(parse(WithFilters, { limit: '51' }));
  });

  it('adds a page number, from 1', async () => {
    class Paged extends WithPageNumber(WithCursorPagination(class {})) {}

    expect((await parse(Paged, { page: '3', limit: '10' })).page).toBe(3);
    await refused(parse(Paged, { page: '0' }));
    await refused(parse(Paged, { page: '1.5' }));
    await refused(parse(Paged, { page: 'x' }));
    expect((await parse(Paged, {})).page).toBeUndefined();
  });
});
