import { ICommand } from '@nestjs/cqrs';

/**
 * Sweep A: payments still waiting for the gateway that have been waiting for a while. Asks the
 * gateway how each one went (a webhook may have been lost) and applies the answer the same way a
 * webhook would be; one whose time to pay has run out and which the gateway still says is pending
 * becomes EXPIRED, and its order with it. Returns how many payments it changed.
 */
export class ReconcilePendingPaymentsCommand implements ICommand {}

/**
 * Sweep B: paid payments whose order is still waiting (the confirmation was cut short). Finishes
 * them. Returns how many it dealt with.
 */
export class FinishPaidPaymentsCommand implements ICommand {}

/**
 * Sweep C: money that has to go back (REFUND_PENDING, and paid payments of orders that are
 * cancelled or expired). Sends it back. Returns how many it refunded.
 */
export class RefundPendingPaymentsCommand implements ICommand {}

/**
 * Sweep D: orders that have been PAYMENT_PROCESSING for a while with no payment alive behind them
 * (the process died between moving the order and writing the payment). Opens them again. Returns how
 * many it opened.
 */
export class ReopenStuckOrdersCommand implements ICommand {}
