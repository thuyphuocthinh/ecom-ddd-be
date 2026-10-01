import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.validation.js';

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('passes through a valid config unchanged', () => {
    const config = { ...VALID, PORT: '3000' };
    expect(validateEnv(config)).toBe(config);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      validateEnv({ JWT_ACCESS_SECRET: VALID.JWT_ACCESS_SECRET }),
    ).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a postgres connection string', () => {
    expect(() =>
      validateEnv({ ...VALID, DATABASE_URL: 'mysql://user:pass@localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a valid port number', () => {
    expect(() => validateEnv({ ...VALID, PORT: 'not-a-number' })).toThrow(
      /PORT/,
    );
  });

  describe('JWT settings', () => {
    it('throws when JWT_ACCESS_SECRET is missing', () => {
      expect(() => validateEnv({ DATABASE_URL: VALID.DATABASE_URL })).toThrow(
        /JWT_ACCESS_SECRET/,
      );
    });

    it('throws when JWT_ACCESS_SECRET is shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...VALID, JWT_ACCESS_SECRET: 'x'.repeat(31) }),
      ).toThrow(/JWT_ACCESS_SECRET/);
    });

    it.each([
      'JWT_ACCESS_TTL_SECONDS',
      'REFRESH_TOKEN_TTL_SECONDS',
      'SESSION_ABSOLUTE_TTL_SECONDS',
    ])('throws when %s is not a positive integer', (name) => {
      expect(() => validateEnv({ ...VALID, [name]: 'abc' })).toThrow(
        new RegExp(name),
      );
      expect(() => validateEnv({ ...VALID, [name]: '0' })).toThrow(
        new RegExp(name),
      );
      expect(() => validateEnv({ ...VALID, [name]: '-5' })).toThrow(
        new RegExp(name),
      );
    });

    it('accepts the TTL variables when they are positive integers (env values are strings)', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          JWT_ACCESS_TTL_SECONDS: '900',
          REFRESH_TOKEN_TTL_SECONDS: '604800',
          SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
        }),
      ).not.toThrow();
    });
  });
});
