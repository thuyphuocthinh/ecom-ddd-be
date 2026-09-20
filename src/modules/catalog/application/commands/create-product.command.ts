export class CreateProductCommand {
  constructor(
    public readonly categoryId: string,
    public readonly name: string,
    public readonly description?: string,
    public readonly thumbnail?: string,
    public readonly skus?: Array<{
      price: number;
      attributes: Record<string, string>;
      skuCode: string;
      barcode?: string;
    }>,
  ) {}
}
