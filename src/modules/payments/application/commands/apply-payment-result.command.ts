import { ICommand } from '@nestjs/cqrs';

/**
 * What a gateway says about a charge, once it is known to be true (the adapter checked the
 * signature, or the sweep asked the gateway itself). The webhook and the sweep both use this: one
 * way in, whatever told us.
 */
export class ApplyPaymentResultCommand implements ICommand {
  constructor(
    public readonly provider: string,
    public readonly providerRef: string,
    public readonly status: 'PAID' | 'FAILED',
    /** What the gateway says it took (or would have taken). */
    public readonly amount: number,
    /**
     * The gateway's id for the message, when there is one (a webhook). A message with the same id is
     * handled once. A sweep that asked the gateway has no message and passes nothing.
     */
    public readonly eventId?: string,
  ) {}
}
