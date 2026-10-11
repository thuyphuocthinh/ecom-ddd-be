import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
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
import { JwtAuthGuard, Roles, RolesGuard } from '@/core/index.js';
import {
  DeliverOrderCommand,
  ShipOrderCommand,
} from '../../application/index.js';
import type { Order } from '../../domain/index.js';
import { OrderResponseDto } from '../dtos/order.dto.js';
import { OrderViewMapper } from '../mappers/order-view.mapper.js';

/**
 * Simulated delivery: an admin moves a confirmed order to SHIPPING and then DELIVERED by hand.
 * The guards sit on the class, so no endpoint added here is reachable without an ADMIN token.
 */
@ApiTags('Admin - Orders')
@ApiBearerAuth()
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminOrderController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post(':id/ship')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'CONFIRMED to SHIPPING' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'No such order (ORD-002)' })
  @ApiResponse({ status: 409, description: 'Not CONFIRMED (ORD-006)' })
  async ship(@Param('id') id: string): Promise<OrderResponseDto> {
    const order = await this.commandBus.execute<ShipOrderCommand, Order>(
      new ShipOrderCommand(id),
    );
    return OrderViewMapper.toDetail(order);
  }

  @Post(':id/deliver')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SHIPPING to DELIVERED' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'No such order (ORD-002)' })
  @ApiResponse({ status: 409, description: 'Not SHIPPING (ORD-006)' })
  async deliver(@Param('id') id: string): Promise<OrderResponseDto> {
    const order = await this.commandBus.execute<DeliverOrderCommand, Order>(
      new DeliverOrderCommand(id),
    );
    return OrderViewMapper.toDetail(order);
  }
}
