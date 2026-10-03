import { registerAs, type ConfigType } from '@nestjs/config';

/** `a, b ,,c` becomes `['a', 'b', 'c']`; nothing set becomes an empty list. */
export function parseClientIds(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Settings for signing in with Google. The only thing needed is the list of client ids this
 * server accepts tokens for (one per platform: web, Android, iOS). There is no client secret:
 * the ID token is checked with Google's public keys. No ids means the feature is off.
 */
export const googleConfig = registerAs('google', () => ({
  clientIds: parseClientIds(process.env.GOOGLE_CLIENT_IDS),
}));

export type GoogleConfig = ConfigType<typeof googleConfig>;
