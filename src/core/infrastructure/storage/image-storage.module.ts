import { Global, Module } from '@nestjs/common';
import { IMAGE_STORAGE } from './image-storage.port.js';
import { createImageStorage } from './image-storage.factory.js';

// Global: any feature (avatars now, product photos later) injects IMAGE_STORAGE without
// importing a feature module. Cloudinary when its settings are present, otherwise uploads answer 503.
@Global()
@Module({
  providers: [
    {
      provide: IMAGE_STORAGE,
      useFactory: () => createImageStorage(process.env),
    },
  ],
  exports: [IMAGE_STORAGE],
})
export class ImageStorageModule {}
