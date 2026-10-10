import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AddressErrorCodes } from '@/core/index.js';
import { RemoveAddressCommand } from './remove-address.command.js';
import { AddressDomainException } from '../../domain/index.js';
import type { IAddressRepository } from '../../domain/index.js';

@CommandHandler(RemoveAddressCommand)
export class RemoveAddressHandler implements ICommandHandler<
  RemoveAddressCommand,
  void
> {
  constructor(
    @Inject('IAddressRepository')
    private readonly addressRepo: IAddressRepository,
  ) {}

  async execute({ userId, addressId }: RemoveAddressCommand): Promise<void> {
    const removed = await this.addressRepo.remove(userId, addressId);
    if (!removed) {
      throw new AddressDomainException(AddressErrorCodes.ADDRESS_NOT_FOUND);
    }
  }
}
