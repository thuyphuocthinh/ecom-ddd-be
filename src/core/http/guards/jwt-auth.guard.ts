import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { TokenStore } from '../../infrastructure/token/token.store.js';
import { DomainException, AuthErrorCodes } from '../../index.js';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface.js';

interface AccessTokenPayload {
  sub: string;
  role: AuthenticatedRequest['user']['role'];
  ver: number;
  exp: number;
}

/**
 * Validates the JWT Access Token on every protected route.
 * Lives in core because it is a cross-cutting concern shared by all feature modules.
 *
 * Checks (in order):
 *  1. Bearer token present in Authorization header
 *  2. Signature valid & not expired (via JwtService, secret from the JwtModule config)
 *  3. Token not blacklisted in Redis (explicit logout)
 *  4. Token version >= global version (logout-all)
 *
 * Checks 3–4 fail CLOSED: if Redis can't answer, the token can't be proven
 * unrevoked, so the request is refused (503, not 401 — the session itself is
 * fine, and a 401 would make clients discard it).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly tokenStore: TokenStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new DomainException(
        AuthErrorCodes.UNAUTHORIZED_ACCESS,
        'Access token missing',
      );
    }

    const payload = await this.verifySignature(token);
    await this.assertNotRevoked(token, payload);

    request.user = { id: payload.sub, role: payload.role, ver: payload.ver };
    request.token = token;
    request.tokenExp = payload.exp;

    return true;
  }

  private async verifySignature(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch (error: any) {
      this.logger.error(`JWT Verification failed: ${error.message}`);
      throw new DomainException(
        AuthErrorCodes.UNAUTHORIZED_ACCESS,
        'Invalid or expired token',
      );
    }
  }

  private async assertNotRevoked(
    token: string,
    payload: AccessTokenPayload,
  ): Promise<void> {
    let isBlacklisted: boolean;
    let currentVersion: number;
    try {
      [isBlacklisted, currentVersion] = await Promise.all([
        this.tokenStore.isAccessTokenBlacklisted(token),
        this.tokenStore.getTokenVersion(payload.sub),
      ]);
    } catch (error: any) {
      this.logger.error(
        `Revocation check unavailable, refusing request: ${error.message}`,
      );
      throw new ServiceUnavailableException(
        'Authentication service temporarily unavailable',
      );
    }

    // 1. Explicit logout
    if (isBlacklisted) {
      throw new DomainException(
        AuthErrorCodes.TOKEN_REVOKED,
        'Token has been revoked',
      );
    }

    // 2. Logout-all
    if (payload.ver < currentVersion) {
      throw new DomainException(
        AuthErrorCodes.UNAUTHORIZED_ACCESS,
        'Session has expired (Logout All)',
      );
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
