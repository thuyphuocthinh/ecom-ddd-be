import { ICommand } from '@nestjs/cqrs';

/** The safety net for lost timers: give back every hold that is past its expiry. */
export class ReleaseExpiredReservationsCommand implements ICommand {}
