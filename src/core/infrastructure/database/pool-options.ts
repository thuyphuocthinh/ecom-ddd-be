import type { PoolConfig } from 'pg';

// Up to this many connections to Postgres per copy of the application. Postgres itself allows
// 100 by default (docker-compose.yml raises it to 200), shared by every copy of the application
// and every other client, so the number of copies times this must stay below that limit. A
// connection pooler (PgBouncer) in front of Postgres is how this is lifted later.
const DEFAULT_POOL_MAX = 100;
// How long a query waits for a free connection before it fails. Without a limit the query would
// wait for ever and a full pool would look like a hang instead of an error.
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

/** The connection pool settings, from the environment (already checked by `validateEnv`). */
export function poolOptions(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: Number(env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX),
    connectionTimeoutMillis: Number(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
  };
}
