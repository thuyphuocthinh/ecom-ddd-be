const DAY = 24;
const HOUR = 60;
const MINUTE = 60;
const SECOND = 1; // Hệ thống này lưu TTL vào Redis dưới dạng Giây (Seconds)

export const buildTTL = (
  unit: 'DAY' | 'HOUR' | 'MINUTE' | 'SECOND',
  value: number,
) => {
  switch (unit) {
    case 'DAY':
      return value * DAY * HOUR * MINUTE * SECOND;
    case 'HOUR':
      return value * HOUR * MINUTE * SECOND;
    case 'MINUTE':
      return value * MINUTE * SECOND;
    case 'SECOND':
      return value * SECOND;
    default:
      return value * DAY * HOUR * MINUTE * SECOND;
  }
};
