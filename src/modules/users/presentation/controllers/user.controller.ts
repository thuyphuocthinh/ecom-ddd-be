import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
} from '@nestjs/swagger';
import {
  GetMeQuery,
  RemoveAvatarCommand,
  UpdateProfileCommand,
  UploadAvatarCommand,
} from '../../application/index.js';
import { UserResponseDto } from '../dtos/user-response.dto.js';
import { UpdateProfileDto } from '../dtos/update-profile.dto.js';
import { UserMapper } from '../mappers/user.mapper.js';
import {
  JwtAuthGuard,
  CurrentUser,
  RateLimit,
  buildTTL,
  MaxBodySizeGuard,
} from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';
import { AVATAR_MAX_BYTES } from '../../domain/index.js';
import type { User } from '../../domain/index.js';

// The file plus a little room for the multipart framing around it
const AVATAR_REQUEST_MAX_BYTES = AVATAR_MAX_BYTES + 8 * 1024;

/** The part of an uploaded file the controller passes on (kept in memory, never on disk). */
interface UploadedImage {
  buffer: Buffer;
}

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UserController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Return the profile of the current user',
    type: UserResponseDto,
  })
  async getMe(@CurrentUser() user: ICurrentUser): Promise<UserResponseDto> {
    const userDomain: User = await this.queryBus.execute(
      new GetMeQuery(user.id),
    );
    return UserMapper.toResponseDto(userDomain);
  }

  @Patch('me')
  @RateLimit({ limit: 20, window: buildTTL('MINUTE', 15), key: 'user' })
  @ApiOperation({ summary: 'Change the display name' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'The name is not valid (USR-006)' })
  async updateProfile(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    const updated: User = await this.commandBus.execute(
      new UpdateProfileCommand(user.id, dto.displayName),
    );
    return UserMapper.toResponseDto(updated);
  }

  @Put('me/avatar')
  @RateLimit({ limit: 5, window: buildTTL('HOUR', 1), key: 'user' })
  // Turns away a request that announces a body over the limit before reading any of it
  @UseGuards(MaxBodySizeGuard(AVATAR_REQUEST_MAX_BYTES))
  @UseInterceptors(
    // Memory storage (no temp files). The request may hold exactly the one file and nothing
    // else (no text fields, no more parts): otherwise a body of many small fields would be
    // kept in memory. Over the size answers 413; anything extra answers 400.
    FileInterceptor('file', {
      limits: {
        fileSize: AVATAR_MAX_BYTES,
        files: 1,
        fields: 0,
        parts: 1,
        headerPairs: 20,
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload the avatar (JPEG, PNG or WebP, at most 2 MB)',
  })
  @ApiResponse({ status: 200, type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Not a valid picture (USR-003)' })
  @ApiResponse({ status: 413, description: 'The file is over 2 MB' })
  @ApiResponse({ status: 503, description: 'Image storage unavailable' })
  async uploadAvatar(
    @CurrentUser() user: ICurrentUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<UserResponseDto> {
    const updated: User = await this.commandBus.execute(
      new UploadAvatarCommand(user.id, file?.buffer),
    );
    return UserMapper.toResponseDto(updated);
  }

  @Delete('me/avatar')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ limit: 20, window: buildTTL('MINUTE', 15), key: 'user' })
  @ApiOperation({ summary: 'Remove the avatar' })
  @ApiResponse({ status: 204, description: 'Removed (or there was none)' })
  async removeAvatar(@CurrentUser() user: ICurrentUser): Promise<void> {
    await this.commandBus.execute(new RemoveAvatarCommand(user.id));
  }
}
