import { Transform } from 'class-transformer';

/**
 * Trim + lowercase, so `A@x.com` and `a@x.com` can't become two accounts and
 * login finds the account regardless of how the user typed their email.
 * Runs before validation (ValidationPipe `transform: true`).
 */
export const NormalizeEmail = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
