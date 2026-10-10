import { ICommand } from '@nestjs/cqrs';

/** Fix holds that were left half-done by a process that died between Redis and Postgres. */
export class RepairInFlightHoldsCommand implements ICommand {}
