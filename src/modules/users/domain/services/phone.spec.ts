import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['0912345678', '0912345678'],
    ['+84912345678', '0912345678'],
    ['84912345678', '0912345678'],
    ['+84 912.345.678', '0912345678'],
    ['0912-345-678', '0912345678'],
    ['0912 345 678', '0912345678'],
    ['(091) 234 5678', '0912345678'],
    ['  0912345678  ', '0912345678'],
  ])('accepts %s and stores %s', (raw, stored) => {
    expect(normalizePhone(raw)).toBe(stored);
  });

  it.each([
    '',
    '   ',
    '091234567', // 9 digits
    '09123456789', // 11 digits
    '+840912345678', // country code and a leading 0
    '912345678', // no leading 0
    '8412345678', // starts like a country code but is not one
    '09123abc78',
    'abcdefghij',
    '+1 202 555 0143',
  ])('refuses %j', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});
