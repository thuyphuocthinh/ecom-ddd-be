import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller.js';
import { LocationsService } from './locations.service.js';

@Module({
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService], // other modules check ward codes with it
})
export class LocationsModule {}
