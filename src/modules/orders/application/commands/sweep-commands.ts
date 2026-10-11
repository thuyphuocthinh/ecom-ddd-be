import { ICommand } from '@nestjs/cqrs';

/** Sweep: online orders still PENDING past their time to pay become EXPIRED. Returns how many. */
export class ExpireDueOrdersCommand implements ICommand {}

/** Sweep: cash-on-delivery orders left PENDING (the confirm was cut short) are finished. */
export class FinishPendingCodOrdersCommand implements ICommand {}

/** Sweep: cancelled orders whose stock is still to be put back get it put back. */
export class ReturnStockForCancelledOrdersCommand implements ICommand {}
