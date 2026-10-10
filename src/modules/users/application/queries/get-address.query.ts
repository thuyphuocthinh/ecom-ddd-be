import { IQuery } from '@nestjs/cqrs';

/** One address of the user as a plain copy of its content (an AddressSnapshot), for the order. */
export class GetAddressQuery implements IQuery {
  constructor(
    public readonly userId: string,
    public readonly addressId: string,
  ) {}
}
