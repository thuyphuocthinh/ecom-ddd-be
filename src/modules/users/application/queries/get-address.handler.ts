import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AddressErrorCodes } from '@/core/index.js';
import { GetAddressQuery } from './get-address.query.js';
import { AddressDomainException } from '../../domain/index.js';
import type {
  AddressSnapshot,
  IAddressRepository,
} from '../../domain/index.js';

@QueryHandler(GetAddressQuery)
export class GetAddressHandler implements IQueryHandler<
  GetAddressQuery,
  AddressSnapshot
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
  ) {}

  async execute({
    userId,
    addressId,
  }: GetAddressQuery): Promise<AddressSnapshot> {
    const address = await this.addressRepo.findOwned(userId, addressId);
    if (!address) {
      // The same answer for an address of another user as for one that does not exist
      throw new AddressDomainException(AddressErrorCodes.ADDRESS_NOT_FOUND);
    }
    return address.toSnapshot();
  }
}
