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
  sid?: string;
}

/**
 * Validates the JWT Access Token on every protected route.
 * Lives in core because it is a cross-cutting concern shared by all feature modules.
 *
 * Checks (in order):
 *  1. Bearer token present in Authorization header
 *  2. Signature valid & not expired (via JwtService, secret from the JwtModule config)
 *  3. Token carries a session id (`sid`); tokens issued before sessions existed don't
 *  4. Session not flagged revoked in Redis (logout, revoke-a-device, reuse detected)
 *  5. Token version >= global version (logout-all)
 *
 * Checks 4–5 fail CLOSED: if Redis can't answer, the token can't be proven
 * unrevoked, so the request is refused (503, not 401 — the session itself is
 * fine, and a 401 would make clients discard it). Neither touches the database.
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
    const sid = this.requireSessionId(payload);
    await this.assertNotRevoked(payload, sid);

    request.user = {
      id: payload.sub,
      role: payload.role,
      ver: payload.ver,
      sid,
    };

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

  // A token without `sid` predates sessions and can't be tied to one: the
  // client must log in again.
  private requireSessionId(payload: AccessTokenPayload): string {
    if (!payload.sid) {
      throw new DomainException(
        AuthErrorCodes.UNAUTHORIZED_ACCESS,
        'Invalid or expired token',
      );
    }
    return payload.sid;
  }

  private async assertNotRevoked(
    payload: AccessTokenPayload,
    sid: string,
  ): Promise<void> {
    let isSessionRevoked: boolean;
    let currentVersion: number;
    try {
      [isSessionRevoked, currentVersion] = await Promise.all([
        this.tokenStore.isSessionRevoked(sid),
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

    // 1. Session revoked (logout, revoke-a-device, reuse detected)
    if (isSessionRevoked) {
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
