import { ICommand } from '@nestjs/cqrs';
import type { StockItem } from '../../domain/index.js';

/** Hold the units of a whole order: every item, or nothing. */
export class ReserveStockCommand implements ICommand {
  constructor(
    public readonly orderId: string,
    public readonly items: ReadonlyArray<StockItem>,
  ) {}
}
