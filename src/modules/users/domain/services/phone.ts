/**
 * A Vietnamese phone number as it will be stored: 10 digits starting with 0 ("0912345678"), or
 * null when it is not one. Spaces, dots, dashes and parentheses between the digits are accepted,
 * and the country code "+84" or "84" may stand in for the leading 0.
 * Only the format is checked; there is no code sent to the number to prove it is real.
 */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s.\-()]/g, '');
  const national = compact.replace(/^(\+84|84)(?=\d{9}$)/, '0');
  return /^0\d{9}$/.test(national) ? national : null;
}
