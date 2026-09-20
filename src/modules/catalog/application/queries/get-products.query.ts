export class GetProductsQuery {
  constructor(
    public readonly limit: number = 20,
    public readonly cursor?: string,
    public readonly categoryId?: string,
  ) {}
}
