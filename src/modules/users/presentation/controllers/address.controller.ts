import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import {
  AddAddressCommand,
  ListAddressesQuery,
  RemoveAddressCommand,
  SetDefaultAddressCommand,
  UpdateAddressCommand,
} from '../../application/index.js';
import { Address } from '../../domain/index.js';
import { AddressResponseDto } from '../dtos/address-response.dto.js';
import { CreateAddressDto } from '../dtos/create-address.dto.js';
import { UpdateAddressDto } from '../dtos/update-address.dto.js';
import { AddressResponseMapper } from '../mappers/address.mapper.js';
import {
  JwtAuthGuard,
  CurrentUser,
  RateLimit,
  buildTTL,
} from '@/core/index.js';
import type { ICurrentUser } from '@/core/index.js';

// Each writing route is counted on its own: 30 calls per user in 15 minutes
const WRITE_LIMIT = {
  limit: 30,
  window: buildTTL('MINUTE', 15),
  key: 'user',
} as const;

/** The address book of the signed-in user. There is no way to name another user here. */
@ApiTags('Addresses')
@Controller('users/me/addresses')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AddressController {
  constructor(
    private readonly queryBus: QueryBus,
    private readonly commandBus: CommandBus,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My addresses (default first, then newest)' })
  @ApiResponse({ status: 200, type: [AddressResponseDto] })
  async list(@CurrentUser() user: ICurrentUser): Promise<AddressResponseDto[]> {
    const addresses: Address[] = await this.queryBus.execute(
      new ListAddressesQuery(user.id),
    );
    return addresses.map(AddressResponseMapper.toResponseDto);
  }

  @Post()
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({ summary: 'Add an address (at most 10)' })
  @ApiResponse({ status: 201, type: AddressResponseDto })
  @ApiResponse({ status: 400, description: 'Not valid (ADDR-003)' })
  @ApiResponse({ status: 409, description: 'Already 10 addresses (ADDR-002)' })
  async add(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: CreateAddressDto,
  ): Promise<AddressResponseDto> {
    const address: Address = await this.commandBus.execute(
      new AddAddressCommand(user.id, dto),
    );
    return AddressResponseMapper.toResponseDto(address);
  }

  @Patch(':id')
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({ summary: 'Change some fields of an address' })
  @ApiParam({ name: 'id', description: 'Address id' })
  @ApiResponse({ status: 200, type: AddressResponseDto })
  @ApiResponse({ status: 400, description: 'Not valid (ADDR-003)' })
  @ApiResponse({
    status: 404,
    description: 'No such address of mine (ADDR-001)',
  })
  async update(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressResponseDto> {
    const address: Address = await this.commandBus.execute(
      new UpdateAddressCommand(user.id, id, { ...dto }),
    );
    return AddressResponseMapper.toResponseDto(address);
  }

  @Put(':id/default')
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({ summary: 'Make an address my default' })
  @ApiParam({ name: 'id', description: 'Address id' })
  @ApiResponse({ status: 200, type: AddressResponseDto })
  @ApiResponse({
    status: 404,
    description: 'No such address of mine (ADDR-001)',
  })
  async setDefault(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<AddressResponseDto> {
    const address: Address = await this.commandBus.execute(
      new SetDefaultAddressCommand(user.id, id),
    );
    return AddressResponseMapper.toResponseDto(address);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({
    summary:
      'Delete an address (the newest remaining becomes the default if needed)',
  })
  @ApiParam({ name: 'id', description: 'Address id' })
  @ApiResponse({ status: 204 })
  @ApiResponse({
    status: 404,
    description: 'No such address of mine (ADDR-001)',
  })
  async remove(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.commandBus.execute(new RemoveAddressCommand(user.id, id));
  }
}
