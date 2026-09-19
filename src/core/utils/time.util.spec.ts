import { describe, it, expect } from 'vitest';
import { TimeUtil } from './time.util.js';
import dayjs from 'dayjs';

describe('TimeUtil', () => {
  it('should get current time in UTC ISO format', () => {
    const time = TimeUtil.getCurrentUtc();
    expect(time.endsWith('Z')).toBe(true);
  });

  it('should add minutes correctly', () => {
    const baseDate = '2024-01-01T12:00:00Z';
    const newDate = TimeUtil.addMinutes(15, baseDate);

    expect(newDate).toBe('2024-01-01T12:15:00.000Z');
  });

  it('should correctly identify expired time', () => {
    const pastDate = dayjs().subtract(1, 'minute').toISOString();
    const futureDate = dayjs().add(1, 'minute').toISOString();

    expect(TimeUtil.isExpired(pastDate)).toBe(true);
    expect(TimeUtil.isExpired(futureDate)).toBe(false);
  });
});
