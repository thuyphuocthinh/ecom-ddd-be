import { Module, Global } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { UsersModule } from '../users/users.module.js';
import { JwtAuthGuard, RolesGuard, appConfig } from '@/core/index.js';
import { authConfig } from './auth.config.js';
import type { AuthConfig } from './auth.config.js';
import {
  RegisterHandler,
  LoginHandler,
  RefreshTokenHandler,
  LogoutHandler,
  LogoutAllHandler,
  VerifyEmailHandler,
  ResendVerificationHandler,
  RevokeSessionHandler,
  RevokeOtherSessionsHandler,
  ListSessionsHandler,
  TokenIssuer,
  SessionIssuer,
  OtpService,
  VerificationMailer,
} from './application/index.js';
import {
  PrismaSessionRepository,
  OtpStore,
  PendingSignupStore,
} from './infrastructure/index.js';
import { AuthController } from './presentation/index.js';
import { SessionController } from './presentation/controllers/session.controller.js';

const CommandHandlers = [
  RegisterHandler,
  LoginHandler,
  RefreshTokenHandler,
  LogoutHandler,
  LogoutAllHandler,
  VerifyEmailHandler,
  ResendVerificationHandler,
  RevokeSessionHandler,
  RevokeOtherSessionsHandler,
];

const QueryHandlers = [ListSessionsHandler];

@Global()
@Module({
  imports: [
    CqrsModule,
    UsersModule,
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(appConfig),
    JwtModule.registerAsync({
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.accessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController, SessionController],
  providers: [
    TokenIssuer,
    SessionIssuer,
    OtpService,
    OtpStore,
    PendingSignupStore,
    VerificationMailer,
    { provide: 'ISessionRepository', useClass: PrismaSessionRepository },
    ...CommandHandlers,
    ...QueryHandlers,
    JwtAuthGuard,
    RolesGuard,
  ],
  // TokenStore comes from the global TokenModule (core), not from here
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
