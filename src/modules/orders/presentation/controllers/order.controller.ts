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
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
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
import type { Observable } from 'rxjs';
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
  CountOrdersByStatusQuery,
  GetOrderQuery,
  ListOrdersQuery,
  OrderStatusStreamService,
  PlaceOrderCommand,
  type PlaceOrderResult,
} from '../../application/index.js';
import type { Order, OrderStatusCounts } from '../../domain/index.js';
import {
  CountOrdersQueryDto,
  ListOrdersQueryDto,
  OrderCountsResponseDto,
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

// Opening a stream is rarer than reading an order: one stream per order page, and it stays open
const STREAM_LIMIT = {
  limit: 20,
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
    private readonly statusStream: OrderStatusStreamService,
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
  @ApiOperation({
    summary: 'My orders, newest first (cursor pagination)',
    description:
      'Narrow the list with `status` (one or more, separated by commas), `createdFrom` and `createdTo` (ISO 8601 with a time zone), and `q` (the start of the order id, for example the 8-character order code).',
  })
  @ApiResponse({ status: 200, type: [OrderSummaryResponseDto] })
  @ApiResponse({
    status: 400,
    description: 'A bad filter, limit or cursor (VAL-001, ORD-000)',
  })
  async list(
    @CurrentUser() user: ICurrentUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<PaginatedResult<OrderSummaryResponseDto>> {
    const page = await this.queryBus.execute<
      ListOrdersQuery,
      PaginatedResult<Order>
    >(
      new ListOrdersQuery(
        user.id,
        query.limit,
        query.cursor,
        query.toFilters(),
      ),
    );
    return { data: page.data.map(OrderViewMapper.toSummary), meta: page.meta };
  }

  // Declared BEFORE `:id`, or "counts" would be taken for an order id
  @Get('counts')
  @RateLimit(READ_LIMIT)
  @ApiOperation({
    summary: 'How many of my orders are in each status',
    description:
      'The same `createdFrom`, `createdTo` and `q` as the list narrow what is counted. Every status is there, 0 when there are none.',
  })
  @ApiResponse({ status: 200, type: OrderCountsResponseDto })
  @ApiResponse({ status: 400, description: 'A bad filter (VAL-001, ORD-000)' })
  async counts(
    @CurrentUser() user: ICurrentUser,
    @Query() query: CountOrdersQueryDto,
  ): Promise<OrderCountsResponseDto> {
    const counts = await this.queryBus.execute<
      CountOrdersByStatusQuery,
      OrderStatusCounts
    >(new CountOrdersByStatusQuery(user.id, query.toFilters()));
    return OrderViewMapper.toCounts(counts);
  }

  @Sse(':id/events')
  @RateLimit(STREAM_LIMIT)
  @ApiOperation({
    summary:
      'The status of one of my orders, pushed as it changes (server-sent events)',
    description:
      'Sends `event: status` with `{ orderId, status }` first with the current status, then at every change; `event: ping` every 20 seconds keeps the connection alive. The stream ends by itself at a final status (DELIVERED, CANCELLED, EXPIRED) and after 30 minutes. Treat a message as "reload the order", not as the data. Send the access token in the `Authorization` header (use `fetch`: `EventSource` cannot).',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'text/event-stream' })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours (ORD-002): the same answer',
  })
  events(
    @CurrentUser() user: ICurrentUser,
    @Param('id') id: string,
  ): Promise<Observable<MessageEvent>> {
    return this.statusStream.open(user.id, id);
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
