import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import type { UserRole } from '@prisma/client';
import { authConfig } from '../../auth.config.js';
import type { AuthConfig } from '../../auth.config.js';

/**
 * Builds the token pair for login and refresh so both mint tokens identically.
 * It only creates them — persisting the refresh token (in the Session) is the
 * caller's job, because login inserts a session while refresh must rotate one atomically.
 */
@Injectable()
export class TokenIssuer {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
  ) {}

  get refreshTtlSeconds(): number {
    return this.config.refreshTtlSeconds;
  }

  get sessionAbsoluteTtlSeconds(): number {
    return this.config.sessionAbsoluteTtlSeconds;
  }

  get accessTtlSeconds(): number {
    return this.config.accessTtlSeconds;
  }

  issue(
    user: { id: string; role: UserRole },
    tokenVersion: number,
    sessionId: string,
  ): { accessToken: string; refreshToken: string } {
    return {
      // expiresIn comes from the JwtModule options (auth config)
      accessToken: this.jwtService.sign({
        sub: user.id,
        role: user.role,
        ver: tokenVersion,
        sid: sessionId,
      }),
      // Opaque, 320-bit
      refreshToken: randomBytes(40).toString('hex'),
    };
  }
}
