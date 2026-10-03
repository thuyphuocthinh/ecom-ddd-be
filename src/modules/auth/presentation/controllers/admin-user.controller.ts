import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  RateLimit,
  buildTTL,
  CurrentUser,
} from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';
import {
  ReinstateUserCommand,
  SuspendUserCommand,
} from '../../application/index.js';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminUserController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post(':id/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 15), key: 'user' })
  @ApiOperation({
    summary: 'Suspend an account and end every session it has',
  })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiResponse({ status: 204, description: 'Suspended (or already was)' })
  @ApiResponse({
    status: 403,
    description: 'Not an admin, or the target is an admin',
  })
  @ApiResponse({ status: 401, description: 'Not logged in' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async suspend(
    @CurrentUser() admin: ICurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.commandBus.execute(new SuspendUserCommand(id, admin.id));
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 15), key: 'user' })
  @ApiOperation({ summary: 'Let a suspended account log in again' })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiResponse({ status: 204, description: 'Reinstated (or was active)' })
  @ApiResponse({ status: 401, description: 'Not logged in' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async reinstate(
    @CurrentUser() admin: ICurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.commandBus.execute(new ReinstateUserCommand(id, admin.id));
  }
}
