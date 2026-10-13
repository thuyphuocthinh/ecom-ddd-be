import { describe, it, expect } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { CountOrdersQueryDto, ListOrdersQueryDto } from './order.dto.js';

// The pipe of the application, so the rules tested here are the ones the requests meet
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const parse = <T>(metatype: new () => T, query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype }) as Promise<T>;
const listOf = (query: Record<string, unknown>) =>
  parse(ListOrdersQueryDto, query);
const refused = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toMatchObject({ status: 400 });
};

describe('the query of GET /orders', () => {
  it('takes no filter at all, with the old defaults', async () => {
    const query = await listOf({});

    expect(query.limit).toBe(20);
    expect(query.status).toBeUndefined();
    expect(query.createdFrom).toBeUndefined();
    expect(query.q).toBeUndefined();
  });

  describe('status', () => {
    it('is one status, or several separated by commas', async () => {
      expect((await listOf({ status: 'CONFIRMED' })).status).toEqual([
        'CONFIRMED',
      ]);
      expect(
        (await listOf({ status: 'PENDING,PAYMENT_PROCESSING' })).status,
      ).toEqual(['PENDING', 'PAYMENT_PROCESSING']);
    });

    it('can name all seven', async () => {
      const all =
        'PENDING,PAYMENT_PROCESSING,CONFIRMED,SHIPPING,DELIVERED,CANCELLED,EXPIRED';

      expect((await listOf({ status: all })).status).toHaveLength(7);
    });

    it.each([
      ['an unknown status', 'NOPE'],
      ['one unknown among good ones', 'PENDING,NOPE'],
      ['nothing', ''],
      ['an empty item', 'PENDING,'],
      ['lower case', 'pending'],
      [
        'more than there are statuses',
        'PENDING,PENDING,PENDING,PENDING,PENDING,PENDING,PENDING,PENDING',
      ],
    ])('refuses %s', async (_label, status) => {
      await refused(listOf({ status }));
    });
  });

  describe('createdFrom and createdTo', () => {
    it.each([
      '2026-10-01T00:00:00Z',
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00+07:00',
      '2026-10-01T00:00:00-05:30',
      '2026-10-01T00:00Z',
    ])('accept %s', async (moment) => {
      const query = await listOf({ createdFrom: moment, createdTo: moment });

      expect(query.createdFrom).toBe(moment);
      expect(query.createdTo).toBe(moment);
    });

    it.each([
      ['a date with no time', '2026-10-01'],
      ['a time with no zone', '2026-10-01T00:00:00'],
      ['not a time', 'yesterday'],
      ['a number', '1791813634'],
      ['a space instead of T', '2026-10-01 00:00:00Z'],
    ])('refuse %s', async (_label, moment) => {
      await refused(listOf({ createdFrom: moment }));
      await refused(listOf({ createdTo: moment }));
    });
  });

  describe('q', () => {
    it('is the start of an id, lower cased', async () => {
      expect((await listOf({ q: '3FA85F64' })).q).toBe('3fa85f64');
      expect((await listOf({ q: '3fa85f64-5717' })).q).toBe('3fa85f64-5717');
    });

    it.each([
      ['too short', '3fa85'],
      ['too long', 'a'.repeat(37)],
      ['not hex', 'xyz12345'],
      ['a wildcard', '3fa85f%'],
      ['a quote', "3fa85f64'"],
    ])('refuses %s', async (_label, q) => {
      await refused(listOf({ q }));
    });
  });

  it('keeps refusing what it did before: a limit out of range and unknown fields', async () => {
    await refused(listOf({ limit: '0' }));
    await refused(listOf({ limit: '51' }));
    await refused(listOf({ userId: 'somebody-else' }));
  });

  it('takes all of them together', async () => {
    const query = await listOf({
      status: 'CONFIRMED,SHIPPING',
      createdFrom: '2026-09-01T00:00:00+07:00',
      createdTo: '2026-09-30T23:59:59+07:00',
      q: '3fa85f64',
      limit: '10',
      cursor: 'abc',
    });

    expect(query).toMatchObject({
      status: ['CONFIRMED', 'SHIPPING'],
      q: '3fa85f64',
      limit: 10,
      cursor: 'abc',
    });
  });
});

describe('the query of GET /orders/counts', () => {
  it('takes the time range and the code, not a status or paging', async () => {
    const query = await parse(CountOrdersQueryDto, {
      createdFrom: '2026-09-01T00:00:00Z',
      q: '3FA85F64',
    });

    expect(query).toMatchObject({
      createdFrom: '2026-09-01T00:00:00Z',
      q: '3fa85f64',
    });
    await refused(parse(CountOrdersQueryDto, { status: 'PENDING' }));
    await refused(parse(CountOrdersQueryDto, { limit: '5' }));
    await refused(parse(CountOrdersQueryDto, { cursor: 'abc' }));
  });

  it('refuses a bad moment or code the same way as the list', async () => {
    await refused(parse(CountOrdersQueryDto, { createdTo: '2026-10-01' }));
    await refused(parse(CountOrdersQueryDto, { q: 'xyz' }));
  });
});

describe('the filters a request asks for', () => {
  it('are none when the request names none', async () => {
    expect((await listOf({})).toFilters()).toEqual({
      createdFrom: undefined,
      createdTo: undefined,
      code: undefined,
      statuses: undefined,
    });
  });

  it('are the statuses once each, the moments as dates and the code in lower case', async () => {
    const filters = (
      await listOf({
        status: 'CONFIRMED,PENDING,CONFIRMED',
        createdFrom: '2026-10-01T00:00:00+07:00',
        createdTo: '2026-10-31T23:59:59Z',
        q: '3FA85F64',
      })
    ).toFilters();

    expect(filters.statuses).toEqual(['CONFIRMED', 'PENDING']);
    expect(filters.createdFrom).toEqual(new Date('2026-09-30T17:00:00.000Z'));
    expect(filters.createdTo).toEqual(new Date('2026-10-31T23:59:59.000Z'));
    expect(filters.code).toBe('3fa85f64');
  });

  it('never have a status when the request is the one that counts', async () => {
    const filters = (
      await parse(CountOrdersQueryDto, { q: '3fa85f64' })
    ).toFilters();

    expect(filters).toEqual({
      createdFrom: undefined,
      createdTo: undefined,
      code: '3fa85f64',
    });
    expect('statuses' in filters).toBe(false);
  });
});
