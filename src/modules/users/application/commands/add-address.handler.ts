import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AddAddressCommand } from './add-address.command.js';
import { Address } from '../../domain/index.js';
import type { IAddressRepository } from '../../domain/index.js';
import { AddressPlaceResolver } from '../services/address-place.resolver.js';

@CommandHandler(AddAddressCommand)
export class AddAddressHandler implements ICommandHandler<
  AddAddressCommand,
  Address
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
    private readonly places: AddressPlaceResolver,
  ) {}

  async execute({ userId, input }: AddAddressCommand): Promise<Address> {
    const place = await this.places.resolve(input.wardCode);
    // Checks every field; throws ADDR-003 naming the one that is wrong
    const address = Address.create({
      id: randomUUID(),
      userId,
      recipientName: input.recipientName,
      phone: input.phone,
      street: input.street,
      label: input.label,
      place,
    });
    // The first address becomes the default by itself; the repository decides under the lock
    return this.addressRepo.add(userId, address, input.isDefault === true);
  }
}
