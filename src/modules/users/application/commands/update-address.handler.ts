import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AddressErrorCodes } from '@/core/index.js';
import { UpdateAddressCommand } from './update-address.command.js';
import { Address, AddressDomainException } from '../../domain/index.js';
import type { AddressPlace, IAddressRepository } from '../../domain/index.js';
import { AddressPlaceResolver } from '../services/address-place.resolver.js';

@CommandHandler(UpdateAddressCommand)
export class UpdateAddressHandler implements ICommandHandler<
  UpdateAddressCommand,
  Address
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
    private readonly places: AddressPlaceResolver,
  ) {}

  async execute({
    userId,
    addressId,
    changes,
  }: UpdateAddressCommand): Promise<Address> {
    const { wardCode, ...fields } = changes;
    if (Object.values(changes).every((value) => value === undefined)) {
      throw new AddressDomainException(AddressErrorCodes.INVALID_ADDRESS, {
        reason: 'NOTHING_TO_UPDATE',
      });
    }

    const current = await this.addressRepo.findOwned(userId, addressId);
    if (!current) throw this.notFound();

    // The place is looked up again only when the ward really changes: otherwise the names saved
    // with the address stay as they were
    let place: AddressPlace | undefined;
    if (wardCode !== undefined && wardCode !== current.wardCode) {
      place = await this.places.resolve(wardCode);
    }

    const updated = current.withChanges({ ...fields, place });
    const saved = await this.addressRepo.update(userId, updated);
    if (!saved) throw this.notFound(); // deleted while we were working
    return saved;
  }

  private notFound() {
    return new AddressDomainException(AddressErrorCodes.ADDRESS_NOT_FOUND);
  }
}
