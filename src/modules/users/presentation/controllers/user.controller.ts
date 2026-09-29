import { Controller, Get, UseGuards } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { GetMeQuery } from '../../application/index.js';
import { UserResponseDto } from '../dtos/user-response.dto.js';
import { UserMapper } from '../mappers/user.mapper.js';
import { JwtAuthGuard, CurrentUser } from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Return the profile of the current user',
    type: UserResponseDto,
  })
  async getMe(@CurrentUser() user: ICurrentUser): Promise<UserResponseDto> {
    const userDomain = await this.queryBus.execute(new GetMeQuery(user.id));
    return UserMapper.toResponseDto(userDomain);
  }
}
