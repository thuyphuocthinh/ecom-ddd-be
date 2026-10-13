import { ICommand } from '@nestjs/cqrs';

export class UpdateSkuPriceCommand implements ICommand {
  constructor(
    public readonly productId: string,
    public readonly skuId: string,
    public readonly price: number,
    /** The price before a discount: a number sets it, `null` removes it, left out keeps it. */
    public readonly compareAtPrice?: number | null,
  ) {}
}
