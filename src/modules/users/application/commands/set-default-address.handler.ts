import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AddressErrorCodes } from '@/core/index.js';
import { SetDefaultAddressCommand } from './set-default-address.command.js';
import { Address, AddressDomainException } from '../../domain/index.js';
import type { IAddressRepository } from '../../domain/index.js';

@CommandHandler(SetDefaultAddressCommand)
export class SetDefaultAddressHandler implements ICommandHandler<
  SetDefaultAddressCommand,
  Address
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
  ) {}

  async execute({
    userId,
    addressId,
  }: SetDefaultAddressCommand): Promise<Address> {
    const address = await this.addressRepo.setDefault(userId, addressId);
    if (!address) {
      throw new AddressDomainException(AddressErrorCodes.ADDRESS_NOT_FOUND);
    }
    return address;
  }
}
