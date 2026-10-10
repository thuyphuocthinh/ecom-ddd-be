import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { ListAddressesQuery } from './list-addresses.query.js';
import { Address } from '../../domain/index.js';
import type { IAddressRepository } from '../../domain/index.js';

@QueryHandler(ListAddressesQuery)
export class ListAddressesHandler implements IQueryHandler<
  ListAddressesQuery,
  Address[]
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
  ) {}

  execute({ userId }: ListAddressesQuery): Promise<Address[]> {
    return this.addressRepo.list(userId);
  }
}
