import { ICommand } from '@nestjs/cqrs';

export class RemoveSkuCommand implements ICommand {
  constructor(
    public readonly productId: string,
    public readonly skuId: string,
  ) {}
}
