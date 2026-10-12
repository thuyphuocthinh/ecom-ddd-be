const JWT_SECRET_MIN_LENGTH = 32;
// Email adapters that exist. `log` only prints messages, so it is for development;
// `smtp` sends through any SMTP server and works in every environment.
const EMAIL_PROVIDERS = ['log', 'smtp'];
const DEV_ONLY_EMAIL_PROVIDERS = ['log'];
// A Google OAuth client id, e.g. 123456789-abc.apps.googleusercontent.com
const GOOGLE_CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;
// Cloudinary keeps profile pictures. It is optional, but its three settings go together
const CLOUDINARY_VARS = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];
const CLOUDINARY_CLOUD_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
// A folder path such as ecom/avatars: letters, digits, _ and -, parts separated by one slash
const CLOUDINARY_FOLDER_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
// Where background jobs (sending email) run: on RabbitMQ, or right inside the request (dev, tests)
const JOB_QUEUES = ['rabbitmq', 'inline'];
// Which payment gateway is used. `fake` is a stand-in that runs inside the application; it never
// moves real money, so it is for development and tests only. A real gateway is added here when
// its adapter exists.
const PAYMENT_GATEWAYS = ['fake'];
const DEV_ONLY_PAYMENT_GATEWAYS = ['fake'];
const PAYMENT_SECRET_MIN_LENGTH = 16;
// Where the built-in local RabbitMQ address may be used
const LOCAL_ENVIRONMENTS = [undefined, 'development', 'test'];
const OPTIONAL_POSITIVE_INT_VARS = [
  'JWT_ACCESS_TTL_SECONDS',
  'REFRESH_TOKEN_TTL_SECONDS',
  'SESSION_ABSOLUTE_TTL_SECONDS',
];
// Payment, database pool, inventory and order settings are whole numbers too. A sweep or publisher interval may be 0: that
// switches it off (tests run it by hand). The hold time is at most 7 days because the "give the
// stock back" timer is a delayed job, and a job may be delayed by 7 days at most.
const INT_SETTING_VARS = [
  {
    name: 'PAYMENT_WINDOW_MINUTES',
    unit: 'minutes',
    min: 1,
    max: 24 * 60,
  },
  {
    name: 'PAYMENT_MAINTENANCE_INTERVAL_SECONDS',
    unit: 'seconds',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: 'PAYMENT_WEBHOOK_TOLERANCE_SECONDS',
    unit: 'seconds',
    min: 1,
    max: 3600,
  },
  {
    name: 'DATABASE_POOL_MAX',
    unit: 'connections',
    min: 1,
    max: 1000,
  },
  {
    name: 'DATABASE_POOL_CONNECTION_TIMEOUT_MS',
    unit: 'milliseconds',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: 'RESERVATION_TTL_MINUTES',
    unit: 'minutes',
    min: 1,
    max: 7 * 24 * 60,
  },
  {
    name: 'INVENTORY_INFLIGHT_GRACE_SECONDS',
    unit: 'seconds',
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: 'INVENTORY_MAINTENANCE_INTERVAL_SECONDS',
    unit: 'seconds',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: 'ORDER_OUTBOX_INTERVAL_MS',
    unit: 'milliseconds',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
  {
    name: 'ORDER_OUTBOX_BATCH_SIZE',
    unit: 'events',
    min: 1,
    max: 1000,
  },
  {
    name: 'ORDER_MAINTENANCE_INTERVAL_SECONDS',
    unit: 'seconds',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
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

  // Sign in with Google is optional; when client ids are given each one must look like one
  if (typeof config.GOOGLE_CLIENT_IDS === 'string') {
    const ids = config.GOOGLE_CLIENT_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const bad = ids.filter((id) => !GOOGLE_CLIENT_ID_PATTERN.test(id));
    if (bad.length > 0) {
      errors.push(
        'GOOGLE_CLIENT_IDS must be a comma-separated list of Google client ids ending in .apps.googleusercontent.com (a client secret is not needed)',
      );
    }
  }

  validateCloudinary(config, errors);
  validatePayment(config, errors);

  for (const name of OPTIONAL_POSITIVE_INT_VARS) {
    if (config[name] === undefined) continue;
    const value = Number(config[name]);
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`${name} must be a positive integer (seconds)`);
    }
  }

  for (const { name, unit, min, max } of INT_SETTING_VARS) {
    if (config[name] === undefined) continue;
    const value = Number(config[name]);
    if (!Number.isInteger(value) || value < min || value > max) {
      const range =
        max === Number.MAX_SAFE_INTEGER
          ? `at least ${min}`
          : `from ${min} to ${max}`;
      errors.push(`${name} must be a whole number of ${unit}, ${range}`);
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

/** The payment gateway must be one that exists, not a stand-in in production, and have its key. */
function validatePayment(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const gateway = (config.PAYMENT_GATEWAY ?? 'fake') as string;
  if (!PAYMENT_GATEWAYS.includes(gateway)) {
    errors.push(
      `PAYMENT_GATEWAY must be one of: ${PAYMENT_GATEWAYS.join(', ')} (got "${gateway}")`,
    );
    return;
  }
  if (
    DEV_ONLY_PAYMENT_GATEWAYS.includes(gateway) &&
    config.NODE_ENV === 'production'
  ) {
    errors.push(
      `PAYMENT_GATEWAY=${gateway} is a stand-in that never moves real money and is not allowed in production`,
    );
  }
  if (gateway === 'fake') {
    const secret = config.PAYMENT_FAKE_WEBHOOK_SECRET;
    if (
      typeof secret !== 'string' ||
      secret.length < PAYMENT_SECRET_MIN_LENGTH
    ) {
      errors.push(
        `PAYMENT_FAKE_WEBHOOK_SECRET must be set to a string of at least ${PAYMENT_SECRET_MIN_LENGTH} characters when PAYMENT_GATEWAY=fake`,
      );
    }
  }
}

/** Image storage is optional; when any setting is given, all three are needed and must look right. */
function validateCloudinary(
  config: Record<string, unknown>,
  errors: string[],
): void {
  const present = (name: string) =>
    typeof config[name] === 'string' && (config[name] as string).trim() !== '';
  const given = CLOUDINARY_VARS.filter(present);

  if (given.length > 0 && given.length < CLOUDINARY_VARS.length) {
    errors.push(
      `${CLOUDINARY_VARS.join(', ')} must all be set together, or none of them (missing: ${CLOUDINARY_VARS.filter((name) => !present(name)).join(', ')})`,
    );
  } else if (
    present('CLOUDINARY_CLOUD_NAME') &&
    !CLOUDINARY_CLOUD_NAME_PATTERN.test(
      (config.CLOUDINARY_CLOUD_NAME as string).trim(),
    )
  ) {
    errors.push(
      'CLOUDINARY_CLOUD_NAME may only contain letters, digits, _ and -',
    );
  }

  if (
    present('CLOUDINARY_FOLDER') &&
    !CLOUDINARY_FOLDER_PATTERN.test((config.CLOUDINARY_FOLDER as string).trim())
  ) {
    errors.push(
      'CLOUDINARY_FOLDER must look like ecom/avatars: letters, digits, _ and -, separated by single slashes',
    );
  }
}
