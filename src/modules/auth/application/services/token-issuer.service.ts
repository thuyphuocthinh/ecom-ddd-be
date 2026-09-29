import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import type { UserRole } from '@prisma/client';
import { authConfig } from '../../auth.config.js';
import type { AuthConfig } from '../../auth.config.js';

/**
 * Builds the token pair for login and refresh so both mint tokens identically.
 * It only creates them — persisting the refresh token is the caller's job,
 * because login stores it while refresh must rotate it atomically.
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

  issue(
    user: { id: string; role: UserRole },
    tokenVersion: number,
  ): { accessToken: string; refreshToken: string } {
    return {
      // expiresIn comes from the JwtModule options (auth config)
      accessToken: this.jwtService.sign({
        sub: user.id,
        role: user.role,
        ver: tokenVersion,
      }),
      // Opaque, 320-bit
      refreshToken: randomBytes(40).toString('hex'),
    };
  }
}
