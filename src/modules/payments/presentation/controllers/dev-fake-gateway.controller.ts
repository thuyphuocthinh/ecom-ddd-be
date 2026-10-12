import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard, RateLimit, buildTTL } from '@/core/index.js';
import { PaymentWebhookService } from '../../application/index.js';
import { GatewayRejected, PAYMENT_GATEWAY } from '../../domain/index.js';
import type { IPaymentGateway } from '../../domain/index.js';
import { FakePaymentGateway } from '../../infrastructure/index.js';
import { FakeGatewayResultDto, FakePayDto } from '../dtos/payment.dto.js';

/**
 * Plays the part of the payment gateway while the real one is not connected: "pays" or "fails" a
 * charge of the fake gateway by sending our own webhook endpoint a message signed the way the
 * gateway would sign it. It goes through the same code as a real webhook, signature included, so
 * what it shows is what a real gateway would cause.
 *
 * It exists only when the fake gateway is the one in use and the server is not in production;
 * otherwise every route answers 404 as if it were not there.
 */
@ApiTags('Dev: fake payment gateway')
@Controller('dev/fake-gateway/charges')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DevFakeGatewayController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    private readonly webhooks: PaymentWebhookService,
  ) {}

  @Post(':providerRef/pay')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 1), key: 'user' })
  @ApiOperation({
    summary: 'Dev only: the customer paid this charge at the fake gateway',
  })
  @ApiParam({ name: 'providerRef' })
  @ApiResponse({ status: 200, type: FakeGatewayResultDto })
  @ApiResponse({
    status: 404,
    description: 'Not the fake gateway, production, or no such charge',
  })
  pay(
    @Param('providerRef') providerRef: string,
    @Body() dto: FakePayDto,
  ): Promise<FakeGatewayResultDto> {
    const fake = this.fake();
    return this.send(fake, providerRef, 'PAID', () =>
      fake.markPaid(providerRef, dto.amount),
    );
  }

  @Post(':providerRef/fail')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, window: buildTTL('MINUTE', 1), key: 'user' })
  @ApiOperation({ summary: 'Dev only: this charge failed at the fake gateway' })
  @ApiParam({ name: 'providerRef' })
  @ApiResponse({ status: 200, type: FakeGatewayResultDto })
  @ApiResponse({
    status: 404,
    description: 'Not the fake gateway, production, or no such charge',
  })
  fail(
    @Param('providerRef') providerRef: string,
  ): Promise<FakeGatewayResultDto> {
    const fake = this.fake();
    return this.send(fake, providerRef, 'FAILED', () =>
      fake.markFailed(providerRef),
    );
  }

  /** The fake gateway, or 404: this is the only place that decides whether the dev routes exist. */
  private fake(): FakePaymentGateway {
    if (
      process.env.NODE_ENV === 'production' ||
      !(this.gateway instanceof FakePaymentGateway)
    ) {
      throw new NotFoundException();
    }
    return this.gateway;
  }

  private async send(
    fake: FakePaymentGateway,
    providerRef: string,
    status: 'PAID' | 'FAILED',
    settle: () => void,
  ): Promise<FakeGatewayResultDto> {
    let notice;
    try {
      // The gateway records the outcome first (as the real one would), then tells us
      settle();
      notice = fake.noticeFor(providerRef, status);
    } catch (error) {
      if (error instanceof GatewayRejected) throw new NotFoundException();
      throw error;
    }
    const reply = await this.webhooks.handle(fake.signNotice(notice));
    return { webhookStatus: reply.httpStatus, eventId: notice.eventId };
  }
}
