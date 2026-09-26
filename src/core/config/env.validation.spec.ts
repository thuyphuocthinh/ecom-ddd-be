import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.validation.js';

describe('validateEnv', () => {
  it('passes through a valid config unchanged', () => {
    const config = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      PORT: '3000',
    };
    expect(validateEnv(config)).toBe(config);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a postgres connection string', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'mysql://user:pass@localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a valid port number', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        PORT: 'not-a-number',
      }),
    ).toThrow(/PORT/);
  });
});
