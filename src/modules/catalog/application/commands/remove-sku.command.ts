export class RemoveSkuCommand {
  constructor(
    public readonly productId: string,
    public readonly skuId: string,
  ) {}
}
