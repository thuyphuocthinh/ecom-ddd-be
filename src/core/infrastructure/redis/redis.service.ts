import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

type TtlValue = number;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly redisClient: Redis;
  private inFlightRequests = new Map<string, Promise<any>>();
  private readonly NULLABLE_SENTINEL = '__NULL_CACHE_SENTINEL__';

  constructor() {
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      db: Number(process.env.REDIS_DB) || 0,
      connectTimeout: 5000,
      // Without this, a command on an already-open-but-unresponsive
      // connection (Redis wedged, network black hole, ...) hangs forever
      // instead of rejecting — every caller here awaits these commands
      // directly, so that would hang the HTTP request itself.
      commandTimeout: 5000,
    });
  }

  getClient(): Redis {
    return this.redisClient;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.redisClient.exists(key)) === 1;
    } catch (error: any) {
      this.logger.error(`Redis exists error: ${error.message}`);
      return false;
    }
  }

  // Health-check liveness
  async ping(): Promise<boolean> {
    try {
      return (await this.redisClient.ping()) === 'PONG';
    } catch (error: any) {
      this.logger.error(`Redis ping error: ${error.message}`);
      return false;
    }
  }

  // Utils
  private withJitter(ttl: number, percent = 0.1): number {
    const delta = ttl * percent;
    const jitter = Math.floor(Math.random() * delta);
    return ttl + jitter;
  }

  private serialize(value: any): string {
    return JSON.stringify(value);
  }

  private deserialize<T>(value: string | null): T | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  // Base cache
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redisClient.get(key);
      return this.deserialize<T>(data);
    } catch (error: any) {
      this.logger.error(`Redis get error: ${error.message}`);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: TtlValue): Promise<void> {
    try {
      if (ttl) {
        const finalTtl = this.withJitter(ttl);
        await this.redisClient.set(key, this.serialize(value), 'EX', finalTtl);
      } else {
        await this.redisClient.set(key, this.serialize(value));
      }
    } catch (error: any) {
      this.logger.error(`Redis set error: ${error.message}`);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch (error: any) {
      this.logger.error(`Redis del error: ${error.message}`);
    }
  }

  // Tracker (version)
  async getVersion(trackerKey: string): Promise<number> {
    const version = await this.redisClient.get(trackerKey);
    return version ? Number(version) : 0;
  }

  async bumpVersion(trackerKey: string): Promise<number> {
    return this.redisClient.incr(trackerKey);
  }

  // Detail cache (Singleflight)
  async getOrSetDetail<T>(
    key: string,
    ttl: TtlValue,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    // 1. Check cache
    const cached = await this.get<T>(key);
    if (cached) return cached;

    // 2. Singleflight
    if (this.inFlightRequests.has(key)) {
      this.logger.debug(
        `Singleflight: Waiting for in-flight request for key: ${key}`,
      );
      return this.inFlightRequests.get(key);
    }

    // 3. Perform fetch
    const fetchPromise = fetcher()
      .then(async (data) => {
        if (data) {
          await this.set(key, data, ttl);
        }
        this.inFlightRequests.delete(key);
        return data;
      })
      .catch((err) => {
        this.inFlightRequests.delete(key);
        throw err;
      });

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  // Nullable Cache (cache cả null để chống cache penetration)
  async getOrSetNullableDetail<T>(
    key: string,
    ttl: TtlValue,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> {
    const cachedStr = await this.redisClient.get(key);
    if (cachedStr === this.NULLABLE_SENTINEL) return null;

    const cached = this.deserialize<T>(cachedStr);
    if (cached) return cached;

    if (this.inFlightRequests.has(key)) {
      return this.inFlightRequests.get(key);
    }

    const fetchPromise = fetcher()
      .then(async (data) => {
        if (data !== null && data !== undefined) {
          await this.set(key, data, ttl);
        } else {
          const finalTtl = this.withJitter(ttl);
          await this.redisClient.set(
            key,
            this.NULLABLE_SENTINEL,
            'EX',
            finalTtl,
          );
        }
        this.inFlightRequests.delete(key);
        return data;
      })
      .catch((err) => {
        this.inFlightRequests.delete(key);
        throw err;
      });

    this.inFlightRequests.set(key, fetchPromise);
    return fetchPromise;
  }

  async invalidateDetail(key: string) {
    await this.del(key);
  }

  async onModuleDestroy() {
    await this.redisClient.quit();
  }
}
