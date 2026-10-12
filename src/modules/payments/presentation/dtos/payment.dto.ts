import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PaymentStatus } from '../../domain/index.js';

export class PaymentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  orderId: string;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ description: 'What the customer has to pay (VND)' })
  amount: number;

  @ApiProperty({
    nullable: true,
    description:
      'Where to pay. Only while the payment is INITIATED; null in every other state.',
  })
  payUrl: string | null;

  @ApiProperty({ description: 'The customer has until this moment to pay' })
  expiresAt: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** Body of the dev endpoint that "pays" a charge of the fake gateway. */
export class FakePayDto {
  @ApiPropertyOptional({
    description:
      'What the fake gateway says it collected. Leave it out to pay the right amount; send another number to try a wrong amount.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount?: number;
}

export class FakeGatewayResultDto {
  @ApiProperty({
    description: 'The HTTP status our own webhook endpoint answered',
  })
  webhookStatus: number;

  @ApiProperty({ description: 'The id of the webhook message that was sent' })
  eventId: string;
}
