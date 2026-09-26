export class UpdateSkuPriceCommand {
  constructor(
    public readonly productId: string,
    public readonly skuId: string,
    public readonly price: number,
  ) {}
}
