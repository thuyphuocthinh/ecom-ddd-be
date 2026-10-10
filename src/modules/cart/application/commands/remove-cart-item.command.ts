export class RemoveCartItemCommand {
  constructor(
    public readonly userId: string,
    public readonly skuId: string,
  ) {}
}
