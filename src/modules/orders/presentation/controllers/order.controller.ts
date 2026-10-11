import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  JwtAuthGuard,
  RateLimit,
  buildTTL,
  type ICurrentUser,
  type PaginatedResult,
} from '@/core/index.js';
import {
  CancelOrderCommand,
  GetOrderQuery,
  ListOrdersQuery,
  PlaceOrderCommand,
  type PlaceOrderResult,
} from '../../application/index.js';
import type { Order } from '../../domain/index.js';
import {
  ListOrdersQueryDto,
  OrderResponseDto,
  OrderSummaryResponseDto,
  PlaceOrderDto,
} from '../dtos/order.dto.js';
import { OrderViewMapper } from '../mappers/order-view.mapper.js';

// Each route is counted on its own, per user, per minute
const WRITE_LIMIT = {
  limit: 10,
  window: buildTTL('MINUTE', 1),
  key: 'user',
} as const;
const READ_LIMIT = {
  limit: 60,
  window: buildTTL('MINUTE', 1),
  key: 'user',
} as const;

/** The orders of the signed-in user. There is no way to name another user here. */
@ApiTags('Orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class OrderController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({
    summary: 'Place an order from my cart',
    description:
      'The same Idempotency-Key from the same user always gives the same order: sending the request again returns that order with 200 and `Idempotency-Replayed: true`.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 100 characters from A-Z a-z 0-9 _ -',
  })
  @ApiResponse({ status: 201, type: OrderResponseDto })
  @ApiResponse({
    status: 200,
    type: OrderResponseDto,
    description: 'The order of an earlier request with the same key',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing or bad Idempotency-Key (ORD-005) or body',
  })
  @ApiResponse({
    status: 404,
    description: 'Address not found (ADDR-001)',
  })
  @ApiResponse({
    status: 409,
    description:
      'Not enough stock (ORD-001), empty cart (ORD-003), items no longer on sale (ORD-004)',
  })
  async place(
    @CurrentUser() user: ICurrentUser,
    @Body() dto: PlaceOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    const { order, replayed } = await this.commandBus.execute<
      PlaceOrderCommand,
      PlaceOrderResult
    >(
      new PlaceOrderCommand(
        user.id,
        idempotencyKey as string,
        dto.addressId,
        dto.paymentMethod,
      ),
    );
    if (replayed) {
      res.status(HttpStatus.OK);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return OrderViewMapper.toDetail(order);
  }

  @Get()
  @RateLimit(READ_LIMIT)
  @ApiOperation({ summary: 'My orders, newest first (cursor pagination)' })
  @ApiResponse({ status: 200, type: [OrderSummaryResponseDto] })
  async list(
    @CurrentUser() user: ICurrentUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<PaginatedResult<OrderSummaryResponseDto>> {
    const page = await this.queryBus.execute<
      ListOrdersQuery,
      PaginatedResult<Order>
    >(new ListOrdersQuery(user.id, query.limit, query.cursor));
    return { data: page.data.map(OrderViewMapper.toSummary), meta: page.meta };
  }

  @Get(':id')
  @RateLimit(READ_LIMIT)
  @ApiOperation({ summary: 'One of my orders' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours (ORD-002): the same answer',
  })
  async get(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<OrderResponseDto> {
    const order = await this.queryBus.execute<GetOrderQuery, Order>(
      new GetOrderQuery(user.id, id),
    );
    return OrderViewMapper.toDetail(order);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({
    summary: 'Cancel one of my orders before it ships (PENDING or CONFIRMED)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours (ORD-002)',
  })
  @ApiResponse({
    status: 409,
    description: 'The order cannot be cancelled from where it is (ORD-006)',
  })
  async cancel(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<OrderResponseDto> {
    const order = await this.commandBus.execute<CancelOrderCommand, Order>(
      new CancelOrderCommand(user.id, id),
    );
    return OrderViewMapper.toDetail(order);
  }
}
