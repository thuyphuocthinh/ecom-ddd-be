import { registerAs, type ConfigType } from '@nestjs/config';

/**
 * Auth settings, parsed once at boot. `validateEnv` has already guaranteed the
 * secret is present and the TTLs are positive integers, so nothing downstream
 * re-parses env strings.
 */
export const authConfig = registerAs('auth', () => ({
  jwtSecret: process.env.JWT_ACCESS_SECRET as string,
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  refreshTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 604800),
  // Hard cap on a session's life from login (30 days), however often it refreshes
  sessionAbsoluteTtlSeconds: Number(
    process.env.SESSION_ABSOLUTE_TTL_SECONDS ?? 2592000,
  ),
}));

export type AuthConfig = ConfigType<typeof authConfig>;
