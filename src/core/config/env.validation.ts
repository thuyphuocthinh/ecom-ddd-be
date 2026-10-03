const JWT_SECRET_MIN_LENGTH = 32;
// Email adapters that exist. `log` only prints messages, so it is for development;
// `smtp` sends through any SMTP server and works in every environment.
const EMAIL_PROVIDERS = ['log', 'smtp'];
const DEV_ONLY_EMAIL_PROVIDERS = ['log'];
// Where background jobs (sending email) run: on RabbitMQ, or right inside the request (dev, tests)
const JOB_QUEUES = ['rabbitmq', 'inline'];
// Where the built-in local RabbitMQ address may be used
const LOCAL_ENVIRONMENTS = [undefined, 'development', 'test'];
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

  const emailProvider = (config.EMAIL_PROVIDER ?? 'log') as string;
  if (!EMAIL_PROVIDERS.includes(emailProvider)) {
    errors.push(
      `EMAIL_PROVIDER must be one of: ${EMAIL_PROVIDERS.join(', ')} (got "${emailProvider}")`,
    );
  } else if (
    config.NODE_ENV === 'production' &&
    DEV_ONLY_EMAIL_PROVIDERS.includes(emailProvider)
  ) {
    // The log adapter prints one-time codes; it must never run in production
    errors.push(
      `EMAIL_PROVIDER=${emailProvider} only prints emails and is not allowed in production; configure a real provider`,
    );
  }

  if (emailProvider === 'smtp') {
    validateSmtp(config, errors);
  }

  const jobQueue = (config.JOB_QUEUE ?? 'rabbitmq') as string;
  if (!JOB_QUEUES.includes(jobQueue)) {
    errors.push(
      `JOB_QUEUE must be one of: ${JOB_QUEUES.join(', ')} (got "${jobQueue}")`,
    );
  } else if (jobQueue === 'inline' && config.NODE_ENV === 'production') {
    // Inline runs the work inside the request: forgot-password would then take visibly longer for
    // an address with an account (look-up, code, email), telling an outsider who is registered
    errors.push(
      'JOB_QUEUE=inline runs background work inside the request and is not allowed in production; use rabbitmq',
    );
  } else if (
    jobQueue === 'rabbitmq' &&
    !LOCAL_ENVIRONMENTS.includes(config.NODE_ENV as string | undefined) &&
    !(typeof config.RABBITMQ_URL === 'string' && config.RABBITMQ_URL.trim())
  ) {
    // The built-in default points at a local broker with the development login, so it is
    // only for development and tests; production, staging and anything else must say where
    errors.push(
      'RABBITMQ_URL must be set unless NODE_ENV is development, test or unset, when JOB_QUEUE=rabbitmq',
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

/** What `EMAIL_PROVIDER=smtp` needs: where to connect, who to send as, and (optionally) a login. */
function validateSmtp(config: Record<string, unknown>, errors: string[]): void {
  const present = (name: string) =>
    typeof config[name] === 'string' && (config[name] as string).trim() !== '';

  if (!present('SMTP_HOST')) {
    errors.push('SMTP_HOST must be set when EMAIL_PROVIDER=smtp');
  }

  if (config.SMTP_PORT !== undefined) {
    const port = Number(config.SMTP_PORT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      errors.push('SMTP_PORT must be a valid integer between 1 and 65535');
    }
  }

  if (
    config.SMTP_SECURE !== undefined &&
    config.SMTP_SECURE !== 'true' &&
    config.SMTP_SECURE !== 'false'
  ) {
    errors.push('SMTP_SECURE must be "true" or "false"');
  }

  // A login is a pair: a user without a password (or the reverse) can never work
  if (present('SMTP_USER') !== present('SMTP_PASS')) {
    errors.push('SMTP_USER and SMTP_PASS must be set together');
  }

  if (!present('EMAIL_FROM') || !(config.EMAIL_FROM as string).includes('@')) {
    errors.push(
      'EMAIL_FROM must be set to a sender address when EMAIL_PROVIDER=smtp, e.g. "Ecom <no-reply@example.com>"',
    );
  }
}
