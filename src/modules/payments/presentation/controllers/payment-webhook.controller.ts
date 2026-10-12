import {
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RateLimit, buildTTL } from '@/core/index.js';
import { PaymentWebhookService } from '../../application/index.js';

/**
 * Where a payment gateway tells us how a payment went. It is public (a gateway has no account
 * here), so the only thing that makes a message believable is its signature, which the adapter of
 * that gateway checks against the raw body. The answer, status and body, is whatever the adapter
 * says the gateway expects, so it is sent as it is and not wrapped like the answers of the rest of
 * the API.
 */
@ApiTags('Payments')
@Controller('payments/webhook')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post(':provider')
  @RateLimit({ limit: 300, window: buildTTL('MINUTE', 1), key: 'ip' })
  @ApiOperation({
    summary:
      'Webhook of the payment gateway (called by the gateway, not by a customer)',
    description:
      'Public, but only a message with a valid signature is accepted. `:provider` must be the gateway this server is set up with.',
  })
  @ApiParam({ name: 'provider', example: 'fake' })
  @ApiResponse({
    status: 200,
    description: 'Received (also for a message already handled)',
  })
  @ApiResponse({
    status: 400,
    description: 'Signed, but not a message we understand',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or wrong signature, changed content, or too old',
  })
  @ApiResponse({ status: 404, description: 'Not the gateway this server uses' })
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.webhooks.isConfigured(provider)) throw new NotFoundException();

    const reply = await this.webhooks.handle({
      // The body exactly as it arrived: the signature is over these bytes, not over parsed JSON
      rawBody: req.rawBody ?? Buffer.alloc(0),
      headers: req.headers,
      query: req.query,
    });
    res.status(reply.httpStatus).json(reply.body);
  }
}
