import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
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
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  RegisterResponseDto,
} from '../dtos/index.js';
import {
  RegisterCommand,
  LoginCommand,
  RefreshTokenCommand,
  LogoutCommand,
  LogoutAllCommand,
} from '../../application/index.js';
import {
  JwtAuthGuard,
  CurrentUser,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser, AuthenticatedRequest } from '@/core/index.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('register')
  @RateLimit({ limit: 3, window: buildTTL('HOUR', 1) })
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: HttpStatus.CREATED, type: RegisterResponseDto })
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    const user = await this.commandBus.execute<RegisterCommand, { id: string }>(
      new RegisterCommand(dto.email, dto.password, dto.displayName),
    );
    return { userId: user.id };
  }

  @Post('login')
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.commandBus.execute(new LoginCommand(dto.email, dto.password));
  }

  @Post('refresh')
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 1) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: HttpStatus.OK, type: AuthResponseDto })
  async refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.commandBus.execute(new RefreshTokenCommand(dto.refreshToken));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and invalidate current session' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RefreshTokenDto,
  ): Promise<void> {
    await this.commandBus.execute(
      new LogoutCommand(req.token, dto.refreshToken, req.tokenExp),
    );
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
