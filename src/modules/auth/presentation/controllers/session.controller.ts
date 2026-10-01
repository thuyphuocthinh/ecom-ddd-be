import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SessionResponseDto } from '../dtos/index.js';
import {
  ListSessionsQuery,
  RevokeOtherSessionsCommand,
  RevokeSessionCommand,
} from '../../application/index.js';
import type { Session } from '../../domain/index.js';
import {
  JwtAuthGuard,
  CurrentUser,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';

@ApiTags('Auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/sessions')
export class SessionController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the devices the current user is logged in on',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [SessionResponseDto] })
  async list(@CurrentUser() user: ICurrentUser): Promise<SessionResponseDto[]> {
    const sessions = await this.queryBus.execute<ListSessionsQuery, Session[]>(
      new ListSessionsQuery(user.id),
    );
    return sessions.map((session) =>
      SessionResponseDto.from(session, user.sid),
    );
  }

  @Post('revoke-others')
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 1), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Log out every device except the current one' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  async revokeOthers(@CurrentUser() user: ICurrentUser): Promise<void> {
    await this.commandBus.execute(
      new RevokeOtherSessionsCommand(user.id, user.sid),
    );
  }

  @Delete(':id')
  @RateLimit({ limit: 10, window: buildTTL('MINUTE', 1), key: 'user' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Log out one of the current user's devices" })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session not found',
  })
  async revoke(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.commandBus.execute(new RevokeSessionCommand(user.id, id));
  }
}
