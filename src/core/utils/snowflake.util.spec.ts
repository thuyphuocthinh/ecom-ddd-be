import { describe, it, expect } from 'vitest';
import { SnowflakeGenerator, snowflake } from './snowflake.util.js';

describe('SnowflakeGenerator', () => {
  it('should generate a string ID', () => {
    const id = snowflake.nextId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique IDs (10000 items)', () => {
    const ids = new Set<string>();
    const count = 10000;
    for (let i = 0; i < count; i++) {
      ids.add(snowflake.nextId());
    }
    expect(ids.size).toBe(count);
  });

  it('should construct with specific machine ID', () => {
    const customSnowflake = new SnowflakeGenerator(5);
    const id = customSnowflake.nextId();
    expect(typeof id).toBe('string');
  });

  it('should throw error if machine ID is out of bounds', () => {
    expect(() => new SnowflakeGenerator(2000)).toThrow();
    expect(() => new SnowflakeGenerator(-1)).toThrow();
  });

  it('should derive a machine ID within valid bounds when PROCESS_ID is unset', () => {
    const original = process.env.PROCESS_ID;
    delete process.env.PROCESS_ID;
    try {
      expect(() => new SnowflakeGenerator()).not.toThrow();
    } finally {
      if (original !== undefined) process.env.PROCESS_ID = original;
    }
  });
});
