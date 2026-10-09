import { IQuery } from '@nestjs/cqrs';

/**
 * Looks up one product for the public storefront: a product that is not
 * PUBLISHED is treated as if it did not exist. Admins use `GetProductByIdQuery`,
 * which returns the product in any status.
 */
export class GetPublishedProductByIdQuery implements IQuery {
  constructor(public readonly id: string) {}
}
