import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { CACHE } from '../../infrastructure/redis/cache.constants.js';
import { RateLimitService } from '../../infrastructure/redis/rate-limit/rate-limit.service.js';
import {
  RATE_LIMIT_KEY,
  RateLimitKey,
  RateLimitOptions,
} from '../decorators/rate-limit.decorator.js';
import type { ICurrentUser } from '../decorators/current-user.decorator.js';

/**
 * Enforces @RateLimit({ limit, window, key }) per route.
 * Registered globally (RateLimitModule); routes without the decorator pass through.
 *
 * An interceptor rather than a guard on purpose: it runs after every guard, so
 * request.user (set by JwtAuthGuard) is available for key: 'user' regardless of
 * how the route orders its @UseGuards.
 *
 * Behind a proxy, enable Express `trust proxy` or every client shares the proxy's IP.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RateLimitInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<
      RateLimitOptions | undefined
    >(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: ICurrentUser }>();
    // Route pattern, not the raw URL: the query string is client-controlled
    // and would let a caller mint a fresh bucket per request.
    const route = request.route?.path ?? request.path;
    const identifier = this.resolveIdentifier(options.key ?? 'ip', request);
    const key = CACHE.RATE_LIMIT.KEYS.BUCKET(route, identifier);

    let allowed: boolean;
    try {
      allowed = await this.rateLimitService.isAllowed(
        key,
        options.limit,
        options.window,
      );
    } catch (error: any) {
      // Fail open: a Redis outage must not take the API down with it.
      this.logger.error(
        `Rate limit check failed for ${route}: ${error.message}`,
      );
      return next.handle();
    }

    if (!allowed) {
      this.logger.warn(`Rate limit exceeded: ${route} (${identifier})`);
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }

  private resolveIdentifier(
    key: RateLimitKey,
    request: Request & { user?: ICurrentUser },
  ): string {
    const ip = `ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;

    if (key === 'ip') {
      return ip;
    }
    if (key === 'user') {
      return request.user ? `user:${request.user.id}` : ip;
    }
    const custom = key(request);
    // Hashed: custom keys often embed an email, which must not sit in Redis keys as plain text.
    return custom
      ? `key:${createHash('sha256').update(custom).digest('hex')}`
      : ip;
  }
}
