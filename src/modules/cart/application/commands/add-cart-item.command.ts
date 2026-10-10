export class AddCartItemCommand {
  constructor(
    public readonly userId: string,
    public readonly skuId: string,
    public readonly quantity: number,
  ) {}
}
