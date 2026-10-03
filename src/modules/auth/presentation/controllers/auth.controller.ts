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
} from '../dtos/index.js';
import {
  RegisterCommand,
  VerifyEmailCommand,
  ResendVerificationCommand,
  LoginCommand,
  RefreshTokenCommand,
  LogoutCommand,
  LogoutAllCommand,
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
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Wrong, expired or already used code',
  })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<AuthResponseDto> {
    return this.commandBus.execute(
      new VerifyEmailCommand(dto.email, dto.code, client),
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
