import { IQuery } from '@nestjs/cqrs';

/**
 * Looks up one product in ANY status (draft and archived included). It does no
 * visibility check, so only admin endpoints may dispatch it. The public
 * storefront uses `GetPublishedProductByIdQuery`.
 */
export class GetProductByIdQuery implements IQuery {
  constructor(public readonly id: string) {}
}
