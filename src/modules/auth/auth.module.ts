import { Module, Global } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { UsersModule } from '../users/users.module.js';
import {
  JwtAuthGuard,
  RolesGuard,
  appConfig,
  JobPayloadCipher,
} from '@/core/index.js';
import { authConfig } from './auth.config.js';
import { googleConfig, type GoogleConfig } from './google.config.js';
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
  PasswordMailer,
  ForgotPasswordHandler,
  ResetPasswordHandler,
  ChangePasswordHandler,
  RequestPasswordResetJobHandler,
  PASSWORD_RESET_PAYLOAD_CIPHER,
  GoogleLoginHandler,
  LinkGoogleHandler,
  UnlinkGoogleHandler,
  GoogleIdentityService,
  AccountMailer,
} from './application/index.js';
import {
  PrismaSessionRepository,
  PrismaPasswordRepository,
  PrismaCredentialRepository,
  JoseGoogleTokenVerifier,
  GoogleTokenStore,
  OtpStore,
  PendingSignupStore,
} from './infrastructure/index.js';
import { AuthController } from './presentation/index.js';
import { SessionController } from './presentation/controllers/session.controller.js';
import { GoogleAuthController } from './presentation/controllers/google-auth.controller.js';
import { GOOGLE_TOKEN_VERIFIER } from './domain/index.js';

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
  ForgotPasswordHandler,
  ResetPasswordHandler,
  ChangePasswordHandler,
  GoogleLoginHandler,
  LinkGoogleHandler,
  UnlinkGoogleHandler,
];

const QueryHandlers = [ListSessionsHandler];

@Global()
@Module({
  imports: [
    CqrsModule,
    UsersModule,
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(appConfig),
    ConfigModule.forFeature(googleConfig),
    JwtModule.registerAsync({
      imports: [ConfigModule.forFeature(authConfig)],
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.accessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController, SessionController, GoogleAuthController],
  providers: [
    TokenIssuer,
    SessionIssuer,
    OtpService,
    OtpStore,
    PendingSignupStore,
    VerificationMailer,
    PasswordMailer,
    RequestPasswordResetJobHandler,
    {
      // Protects the address that waits in the queue for a password reset
      provide: PASSWORD_RESET_PAYLOAD_CIPHER,
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) =>
        new JobPayloadCipher(config.jwtSecret, 'jobs-password-reset-v1'),
    },
    { provide: 'ISessionRepository', useClass: PrismaSessionRepository },
    { provide: 'IPasswordRepository', useClass: PrismaPasswordRepository },
    { provide: 'ICredentialRepository', useClass: PrismaCredentialRepository },
    GoogleTokenStore,
    GoogleIdentityService,
    AccountMailer,
    {
      // Checks Google ID tokens against Google's public keys; no secret is involved
      provide: GOOGLE_TOKEN_VERIFIER,
      inject: [googleConfig.KEY],
      useFactory: (config: GoogleConfig) =>
        new JoseGoogleTokenVerifier(config.clientIds),
    },
    ...CommandHandlers,
    ...QueryHandlers,
    JwtAuthGuard,
    RolesGuard,
  ],
  // TokenStore comes from the global TokenModule (core), not from here
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
