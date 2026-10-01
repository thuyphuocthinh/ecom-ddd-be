const JWT_SECRET_MIN_LENGTH = 32;
const OPTIONAL_POSITIVE_INT_VARS = [
  'JWT_ACCESS_TTL_SECONDS',
  'REFRESH_TOKEN_TTL_SECONDS',
  'SESSION_ABSOLUTE_TTL_SECONDS',
];

/**
 * Fails fast at boot when a required environment variable is missing or
 * malformed, instead of letting a service crash later the first time it
 * actually tries to use it (e.g. PrismaService connecting with an
 * undefined DATABASE_URL, or login failing at sign() for a missing JWT secret).
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];

  const databaseUrl = config.DATABASE_URL;
  if (
    typeof databaseUrl !== 'string' ||
    !/^postgres(ql)?:\/\/.+/.test(databaseUrl)
  ) {
    errors.push('DATABASE_URL must be set to a postgres:// connection string');
  }

  if (config.PORT !== undefined) {
    const port = Number(config.PORT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.push('PORT must be a valid integer between 1 and 65535');
    }
  }

  const jwtSecret = config.JWT_ACCESS_SECRET;
  if (
    typeof jwtSecret !== 'string' ||
    jwtSecret.length < JWT_SECRET_MIN_LENGTH
  ) {
    errors.push(
      `JWT_ACCESS_SECRET must be set to a string of at least ${JWT_SECRET_MIN_LENGTH} characters`,
    );
  }

  for (const name of OPTIONAL_POSITIVE_INT_VARS) {
    if (config[name] === undefined) continue;
    const value = Number(config[name]);
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer (seconds)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
