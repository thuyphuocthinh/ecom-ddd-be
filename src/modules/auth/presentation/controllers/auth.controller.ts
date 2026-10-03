import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  RegisterDto,
  VerifyEmailDto,
  ResendVerificationDto,
  ResendVerificationResponseDto,
  LoginDto,
  RefreshTokenDto,
  LogoutDto,
  AuthResponseDto,
  RegisterResponseDto,
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from '../dtos/index.js';
import {
  RegisterCommand,
  VerifyEmailCommand,
  ResendVerificationCommand,
  LoginCommand,
  RefreshTokenCommand,
  LogoutCommand,
  LogoutAllCommand,
  ForgotPasswordCommand,
  ResetPasswordCommand,
  ChangePasswordCommand,
} from '../../application/index.js';
import {
  JwtAuthGuard,
  CurrentUser,
  ClientInfo,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser, IClientInfo } from '@/core/index.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('register')
  @RateLimit({ limit: 3, window: buildTTL('HOUR', 1) })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start registration: emails a 6-digit code to confirm the address',
    description:
      'No account exists yet. Enter the code at POST /auth/verify-email to create it and log in.',
  })
  @ApiResponse({ status: HttpStatus.ACCEPTED, type: RegisterResponseDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Email already has an account',
  })
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.commandBus.execute(
      new RegisterCommand(dto.email, dto.password, dto.displayName),
    );
  }

  @Post('verify-email')
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm the emailed code: creates the account and logs in',
    description:
      'The password must be the one sent to /auth/register. It proves the person confirming is the person who registered, so somebody who re-registered the address with their own password cannot take the account over.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Wrong, expired or already used code, or a password that differs from the one used to register (AUTH-011)',
  })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<AuthResponseDto> {
    return this.commandBus.execute(
      new VerifyEmailCommand(dto.email, dto.code, dto.password, client),
    );
  }

  @Post('resend-verification')
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Send the code again',
    description:
      'Only for a registration that is still waiting. When nothing is waiting (never registered, already has an account, or it timed out) it answers 404, and the user should register again.',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: ResendVerificationResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No registration is waiting for this email; register again',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'Asked again too soon, or too many codes this hour. `errors.retryAfterSeconds` (and the Retry-After header) say how long to wait',
  })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.commandBus.execute(new ResendVerificationCommand(dto.email));
  }

  @Post('forgot-password')
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Forgot the password: email a code to reset it',
    description:
      'Always answers 202 with the same body, whether or not the address has an account, so it cannot be used to find out who is registered. If there is an account, a code arrives by email shortly. Call this again to get a new code (same cooldown).',
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: ForgotPasswordResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'Asked again too soon, or too many codes this hour; the same for every address. `errors.retryAfterSeconds` says how long to wait',
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.commandBus.execute(new ForgotPasswordCommand(dto.email));
  }

  @Post('reset-password')
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with the emailed code',
    description:
      'Closes every session of the account and does not log anyone in: log in again with the new password.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Wrong, expired or used code (AUTH-008), or a new password that is too easy to guess (AUTH-010, with the reason)',
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<void> {
    await this.commandBus.execute(
      new ResetPasswordCommand(dto.email, dto.code, dto.newPassword, client),
    );
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change the password of the logged-in user',
    description:
      'Needs the current password. The other devices are logged out; this one stays logged in.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Wrong current password (AUTH-012), or a new password that is the same as the current one or too easy to guess (AUTH-010, with the reason)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The password was changed by another request while this one was being processed (AUTH-013)',
  })
  async changePassword(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.commandBus.execute(
      new ChangePasswordCommand(
        user.id,
        user.sid,
        dto.currentPassword,
        dto.newPassword,
      ),
    );
  }

  @Post('login')
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  async login(
    @Body() dto: LoginDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<AuthResponseDto> {
    return this.commandBus.execute(
      new LoginCommand(dto.email, dto.password, client),
    );
  }

  @Post('refresh')
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 1) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<AuthResponseDto> {
    return this.commandBus.execute(
      new RefreshTokenCommand(dto.refreshToken, client.ip),
    );
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 1), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and invalidate current session' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  async logout(
    @CurrentUser() user: ICurrentUser,
    // Accepted for older clients, not used: the session comes from the access token
    @Body() _dto: LogoutDto,
  ): Promise<void> {
    await this.commandBus.execute(new LogoutCommand(user.sid, user.id));
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  async logoutAll(@CurrentUser() user: ICurrentUser): Promise<void> {
    await this.commandBus.execute(new LogoutAllCommand(user.id));
  }
}
