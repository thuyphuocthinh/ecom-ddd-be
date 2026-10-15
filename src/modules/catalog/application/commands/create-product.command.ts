import { ICommand } from '@nestjs/cqrs';

export class CreateProductCommand implements ICommand {
  constructor(
    public readonly categoryId: string,
    public readonly name: string,
    public readonly description?: string,
    public readonly thumbnail?: string,
    public readonly skus?: Array<{
      price: number;
      compareAtPrice?: number;
      attributes: Record<string, string>;
      skuCode: string;
      barcode?: string;
    }>,
    public readonly slug?: string,
  ) {}
}
