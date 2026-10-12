import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
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
} from '@/core/index.js';
import {
  ListOrderPaymentsQuery,
  StartPaymentCommand,
  type StartPaymentResult,
} from '../../application/index.js';
import type { Payment } from '../../domain/index.js';
import { PaymentResponseDto } from '../dtos/payment.dto.js';
import { PaymentViewMapper } from '../mappers/payment-view.mapper.js';

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

/** The payments of the orders of the signed-in user. There is no way to name another user here. */
@ApiTags('Payments')
@Controller('orders/:orderId/payments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaymentController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  @RateLimit(WRITE_LIMIT)
  @ApiOperation({
    summary: 'Start paying one of my online orders',
    description:
      'The same Idempotency-Key for the same order always gives the same payment: sending the request again returns that payment with 200 and `Idempotency-Replayed: true`, and the customer is never charged twice. Send the customer to `payUrl`.',
  })
  @ApiParam({ name: 'orderId' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 100 characters from A-Z a-z 0-9 _ -',
  })
  @ApiResponse({ status: 201, type: PaymentResponseDto })
  @ApiResponse({
    status: 200,
    type: PaymentResponseDto,
    description: 'The payment of an earlier request with the same key',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing or bad Idempotency-Key (PAY-001)',
  })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours (ORD-002): the same answer',
  })
  @ApiResponse({
    status: 409,
    description:
      'Not an online order (PAY-002), not payable now (PAY-003), too many attempts (PAY-004), time to pay is over or the held stock is gone (PAY-005)',
  })
  @ApiResponse({
    status: 503,
    description: 'The payment gateway cannot be reached (PAY-006)',
  })
  async start(
    @CurrentUser() user: ICurrentUser,
    @Param('orderId') orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentResponseDto> {
    const { payment, replayed } = await this.commandBus.execute<
      StartPaymentCommand,
      StartPaymentResult
    >(new StartPaymentCommand(user.id, orderId, idempotencyKey as string));
    if (replayed) {
      res.status(HttpStatus.OK);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return PaymentViewMapper.toView(payment);
  }

  @Get()
  @RateLimit(READ_LIMIT)
  @ApiOperation({ summary: 'The payments of one of my orders, newest first' })
  @ApiParam({ name: 'orderId' })
  @ApiResponse({ status: 200, type: [PaymentResponseDto] })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not yours (ORD-002): the same answer',
  })
  async list(
    @CurrentUser() user: ICurrentUser,
    @Param('orderId') orderId: string,
  ): Promise<PaymentResponseDto[]> {
    const payments = await this.queryBus.execute<
      ListOrderPaymentsQuery,
      Payment[]
    >(new ListOrderPaymentsQuery(user.id, orderId));
    return payments.map(PaymentViewMapper.toView);
  }
}
