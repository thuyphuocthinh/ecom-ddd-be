/**
 * Fails fast at boot when a required environment variable is missing or
 * malformed, instead of letting a service crash later the first time it
 * actually tries to use it (e.g. PrismaService connecting with an
 * undefined DATABASE_URL).
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

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}
