import { poolOptions } from './pool-options.js';

describe('poolOptions', () => {
  it('uses 100 connections and a 5 second wait for a free one when nothing is set', () => {
    expect(poolOptions({ DATABASE_URL: 'postgresql://x' })).toEqual({
      connectionString: 'postgresql://x',
      max: 100,
      connectionTimeoutMillis: 5000,
    });
  });

  it('takes the size and the wait from the environment', () => {
    expect(
      poolOptions({
        DATABASE_URL: 'postgresql://x',
        DATABASE_POOL_MAX: '20',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: '250',
      }),
    ).toMatchObject({ max: 20, connectionTimeoutMillis: 250 });
  });

  it('lets 0 mean "wait for ever" for the connection timeout, as the pg library does', () => {
    expect(
      poolOptions({
        DATABASE_URL: 'postgresql://x',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: '0',
      }).connectionTimeoutMillis,
    ).toBe(0);
  });
});
