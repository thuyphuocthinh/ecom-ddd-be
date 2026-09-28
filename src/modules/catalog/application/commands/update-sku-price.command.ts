import { ICommand } from '@nestjs/cqrs';

export class UpdateSkuPriceCommand implements ICommand {
  constructor(
    public readonly productId: string,
    public readonly skuId: string,
    public readonly price: number,
  ) {}
}
