export class AddSkuCommand {
  constructor(
    public readonly productId: string,
    public readonly skuCode: string,
    public readonly price: number,
    public readonly attributes: Record<string, string>,
    public readonly barcode?: string,
  ) {}
}
