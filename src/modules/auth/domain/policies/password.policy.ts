import { COMMON_PASSWORDS } from './common-passwords.js';

export type WeakPasswordReason =
  /** On the list of passwords everyone tries first, alone or with digits/symbols tacked on. */
  | 'COMMON'
  /** The same character over and over, or a run like 12345678 / abcdefgh. */
  | 'REPEATED_OR_SEQUENTIAL'
  /** Contains the user's own email (or the name part of it). */
  | 'CONTAINS_EMAIL'
  /** Contains a word of the shop's name. */
  | 'CONTAINS_APP_NAME';

// Shorter pieces match too many innocent passwords to be worth refusing
const MIN_WORD_LENGTH = 4;

/**
 * Why a password is too easy to guess, or null when it is fine. Length is not checked
 * here (the request DTO does that); this is about what an attacker would try, and no
 * composition rule such as "one capital letter": those only push people to `Password1!`.
 */
export function findPasswordWeakness(params: {
  password: string;
  email: string;
  appName: string;
}): WeakPasswordReason | null {
  const password = params.password.toLowerCase();

  if (isCommon(password)) return 'COMMON';
  if (isRepeatedOrSequential(password)) return 'REPEATED_OR_SEQUENTIAL';
  if (containsEmail(password, params.email)) return 'CONTAINS_EMAIL';
  if (containsShopName(password, params.appName)) return 'CONTAINS_APP_NAME';
  return null;
}

// `iloveyou2026!` is `iloveyou` with a tail, which an attacker tries too
function isCommon(password: string): boolean {
  if (COMMON_PASSWORDS.has(password)) return true;
  const withoutTail = password.replace(/[^\p{L}]+$/u, '');
  return (
    withoutTail.length >= MIN_WORD_LENGTH && COMMON_PASSWORDS.has(withoutTail)
  );
}

function isRepeatedOrSequential(password: string): boolean {
  const codes = Array.from(password, (char) => char.codePointAt(0) ?? 0);
  if (codes.length < 2) return false;
  const step = codes[1] - codes[0];
  // step 0: all the same character; ±1: an ascending or descending run
  return (
    [0, 1, -1].includes(step) &&
    codes.every((code, i) => i === 0 || code - codes[i - 1] === step)
  );
}

function containsEmail(password: string, email: string): boolean {
  const address = email.toLowerCase();
  const name = address.split('@')[0];
  return (
    password === address ||
    (name.length >= MIN_WORD_LENGTH && password.includes(name))
  );
}

function containsShopName(password: string, appName: string): boolean {
  return appName
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH)
    .some((word) => password.includes(word));
}
