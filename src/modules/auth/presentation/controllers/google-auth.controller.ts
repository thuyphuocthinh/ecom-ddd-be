import {
  Body,
  Controller,
  Delete,
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
  GoogleTokenDto,
  GoogleLoginResponseDto,
  LinkGoogleDto,
} from '../dtos/index.js';
import {
  GoogleLoginCommand,
  LinkGoogleCommand,
  UnlinkGoogleCommand,
} from '../../application/index.js';
import {
  ClientInfo,
  CurrentUser,
  JwtAuthGuard,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser, IClientInfo } from '@/core/index.js';

@ApiTags('Auth')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 15) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in (or sign up) with a Google ID token',
    description:
      'Send the `credential` that Google Identity Services gives the page. A new person gets an account; a person whose Google account is linked is logged in; a person whose verified email already has an account gets Google linked to it (and an email telling them).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: GoogleLoginResponseDto })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'The token is not acceptable (AUTH-014)',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Google says the email is not verified (AUTH-015)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The account is linked to a different Google account (AUTH-016)',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'Sign in with Google is not enabled (AUTH-018), or Google could not be reached',
  })
  async login(
    @Body() dto: GoogleTokenDto,
    @ClientInfo() client: IClientInfo,
  ): Promise<GoogleLoginResponseDto> {
    return this.commandBus.execute(
      new GoogleLoginCommand(dto.idToken, dto.nonce, client),
    );
  }

  @Post('link')
  @UseGuards(JwtAuthGuard)
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Link a Google account to the logged-in account',
    description:
      'An account that has a password must send it as `currentPassword` (a stolen access token alone cannot add a way to log in). The owner is emailed.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Wrong or missing current password (AUTH-012)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'That Google account belongs to someone else, or this account has a different one (AUTH-016)',
  })
  async link(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: LinkGoogleDto,
  ): Promise<void> {
    await this.commandBus.execute(
      new LinkGoogleCommand(
        user.id,
        dto.idToken,
        dto.nonce,
        dto.currentPassword,
      ),
    );
  }

  @Delete()
  @UseGuards(JwtAuthGuard)
  @RateLimit({ limit: 5, window: buildTTL('MINUTE', 15), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Unlink the Google account from the logged-in account',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Google is the only way to log in (AUTH-017)',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No Google account is linked (AUTH-019)',
  })
  async unlink(@CurrentUser() user: ICurrentUser): Promise<void> {
    await this.commandBus.execute(new UnlinkGoogleCommand(user.id));
  }
}
