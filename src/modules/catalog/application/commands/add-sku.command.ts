import { ICommand } from '@nestjs/cqrs';

export class AddSkuCommand implements ICommand {
  constructor(
    public readonly productId: string,
    public readonly skuCode: string,
    public readonly price: number,
    public readonly attributes: Record<string, string>,
    public readonly barcode?: string,
  ) {}
}
