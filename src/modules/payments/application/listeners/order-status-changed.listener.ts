import { CommandBus } from '@nestjs/cqrs';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  EVENT_BUS,
  type IEventBus,
  type IntegrationEvent,
} from '@/core/index.js';
import { OrderStatus } from '../../../orders/domain/index.js';
import {
  PaymentStatus,
  type IInboxStore,
  type IPaymentRepository,
} from '../../domain/index.js';
import { RefundPaymentCommand } from '../commands/refund-payment.command.js';

/** The queue of this consumer on the event bus, and the name its handled events are noted under. */
export const ORDER_EVENTS_CONSUMER = 'payments.order-events';

/**
 * A consumer of the event bus: when an order that was paid (CONFIRMED) is cancelled, the money of
 * its payment goes back. It is the FAST way; nothing depends on it, because the refund sweep (C)
 * finds the same payments (paid, order cancelled) if the event is lost or this consumer is down.
 *
 * Delivery is at least once, so the same event can come twice: each is noted in the inbox by its id
 * and handled once. If handling fails the note is taken back and the error goes on, so the event
 * ends up in the dead-letter queue instead of being lost (and the sweep refunds it meanwhile).
 */
@Injectable()
export class OrderStatusChangedListener implements OnModuleInit {
  private readonly logger = new Logger(OrderStatusChangedListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject('IInboxStore') private readonly inbox: IInboxStore,
    @Inject('IPaymentRepository')
    private readonly payments: IPaymentRepository,
    private readonly commandBus: CommandBus,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(
      { name: ORDER_EVENTS_CONSUMER, pattern: 'order.status_changed' },
      (event) => this.handle(event),
    );
  }

  async handle(event: IntegrationEvent): Promise<void> {
    const orderId = this.cancelledPaidOrder(event.data);
    if (!orderId) return; // some other change of an order: not ours

    if (!(await this.inbox.record(ORDER_EVENTS_CONSUMER, event.id))) return;
    try {
      const payments = await this.payments.listByOrder(orderId);
      for (const payment of payments) {
        if (payment.status !== PaymentStatus.SUCCEEDED) continue;
        // The order is cancelled (that is what the event says), so its paid payment goes back
        await this.commandBus.execute(
          new RefundPaymentCommand(payment.id, { markFirst: true }),
        );
      }
    } catch (error) {
      await this.inbox
        .forget(ORDER_EVENTS_CONSUMER, event.id)
        .catch((forgetError: Error) =>
          this.logger.error(
            `Could not take event ${event.id} back out of the inbox: ${forgetError.message}`,
          ),
        );
      throw error;
    }
  }

  /** The order id when the event says a CONFIRMED order was cancelled; otherwise null. */
  private cancelledPaidOrder(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const { orderId, from, to } = data as Record<string, unknown>;
    if (
      typeof orderId === 'string' &&
      orderId !== '' &&
      from === OrderStatus.CONFIRMED &&
      to === OrderStatus.CANCELLED
    ) {
      return orderId;
    }
    return null;
  }
}
