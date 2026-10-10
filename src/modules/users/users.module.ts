import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaUserRepository } from './infrastructure/database/prisma-user.repository.js';
import { GetMeHandler } from './application/queries/get-me.handler.js';
import { UpdateProfileHandler } from './application/commands/update-profile.handler.js';
import { UploadAvatarHandler } from './application/commands/upload-avatar.handler.js';
import { RemoveAvatarHandler } from './application/commands/remove-avatar.handler.js';
import { UserController } from './presentation/controllers/user.controller.js';
import { PrismaAddressRepository } from './infrastructure/database/prisma-address.repository.js';
import {
  AddAddressHandler,
  UpdateAddressHandler,
  RemoveAddressHandler,
  SetDefaultAddressHandler,
  ListAddressesHandler,
  GetAddressHandler,
  AddressPlaceResolver,
} from './application/index.js';
import { AddressController } from './presentation/controllers/address.controller.js';
import { LocationsModule } from '../locations/locations.module.js';

@Module({
  imports: [CqrsModule, LocationsModule], // LocationsModule: the wards an address can be in
  controllers: [UserController, AddressController],
  providers: [
    {
      provide: 'IUserRepository',
      useClass: PrismaUserRepository,
    },
    GetMeHandler,
    UpdateProfileHandler,
    UploadAvatarHandler,
    RemoveAvatarHandler,
    {
      provide: 'IAddressRepository',
      useClass: PrismaAddressRepository,
    },
    AddAddressHandler,
    UpdateAddressHandler,
    RemoveAddressHandler,
    SetDefaultAddressHandler,
    ListAddressesHandler,
    GetAddressHandler,
    AddressPlaceResolver,
  ],
  exports: ['IUserRepository'], // Export cho AuthModule dùng
})
export class UsersModule {}
