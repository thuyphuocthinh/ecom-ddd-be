import { Module, Global } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { UsersModule } from '../users/users.module.js';
import { JwtAuthGuard, RolesGuard } from '@/core/index.js';
import { authConfig } from './auth.config.js';
import type { AuthConfig } from './auth.config.js';
import {
  RegisterHandler,
  LoginHandler,
  RefreshTokenHandler,
  LogoutHandler,
  LogoutAllHandler,
  TokenIssuer,
} from './application/index.js';
import { AuthController } from './presentation/index.js';

const CommandHandlers = [
  RegisterHandler,
  LoginHandler,
  RefreshTokenHandler,
  LogoutHandler,
  LogoutAllHandler,
];

@Global()
@Module({
  imports: [
    CqrsModule,
    UsersModule,
    ConfigModule.forFeature(authConfig),
    JwtModule.registerAsync({
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.accessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [TokenIssuer, ...CommandHandlers, JwtAuthGuard, RolesGuard],
  // TokenStore comes from the global TokenModule (core), not from here
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
