import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { InventoryErrorCodes } from '@/core/index.js';
import {
  InventoryDomainException,
  type IReservationRepository,
} from '../../domain/index.js';
import { ExtendReservationCommand } from './extend-reservation.command.js';

// A hold is never extended by more than a week at a time (the same limit as the hold time itself)
export const MAX_EXTENSION_SECONDS = 7 * 24 * 60 * 60;

export interface ExtendReservationResult {
  orderId: string;
  /** The hold now lasts until this time. */
  expiresAt: Date;
}

/**
 * Holds the stock of an order for longer. Postgres only (one conditional update, judged by the
 * database clock); Redis already counts these units as held and keeps doing so. The timer that was
 * set for the old expiry finds the hold not yet expired and does nothing; the periodic sweep gives
 * the units back when the new expiry comes (at most one sweep late).
 *
 * Refused (`INV-009`) when the hold is already given back, paid, returned or past its expiry: a
 * hold that is gone is not brought back, the order has to start again. `INV-003` for an order
 * that holds nothing.
 */
@CommandHandler(ExtendReservationCommand)
export class ExtendReservationHandler implements ICommandHandler<
  ExtendReservationCommand,
  ExtendReservationResult
> {
  constructor(
    @Inject('IReservationRepository')
    private readonly reservationRepo: IReservationRepository,
  ) {}

  async execute(
    command: ExtendReservationCommand,
  ): Promise<ExtendReservationResult> {
    if (
      typeof command.orderId !== 'string' ||
      command.orderId.trim() === '' ||
      !Number.isInteger(command.seconds) ||
      command.seconds < 1 ||
      command.seconds > MAX_EXTENSION_SECONDS
    ) {
      throw new InventoryDomainException(
        InventoryErrorCodes.INVALID_RESERVATION_REQUEST,
      );
    }

    const result = await this.reservationRepo.extend(
      command.orderId,
      command.seconds,
    );
    switch (result.kind) {
      case 'EXTENDED':
        return { orderId: command.orderId, expiresAt: result.expiresAt };
      case 'NOT_EXTENDABLE':
        throw new InventoryDomainException(
          InventoryErrorCodes.EXTEND_NOT_ALLOWED,
        );
      case 'NOT_FOUND':
        throw new InventoryDomainException(
          InventoryErrorCodes.RESERVATION_NOT_FOUND,
        );
    }
  }
}
