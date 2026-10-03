import { DomainException } from '../../domain/exceptions/domain.exception.js';
import { StorageErrorCodes } from '../../domain/exceptions/error-codes.js';
import type { IImageStorage, ImageUpload } from './image-storage.port.js';

/**
 * Used when no image service is configured: uploading answers 503 and says why; everything else
 * keeps working, and removing a picture has nothing to remove from.
 */
export class UnconfiguredImageStorage implements IImageStorage {
  upload(_request: ImageUpload): Promise<string> {
    return Promise.reject(
      new DomainException(StorageErrorCodes.NOT_CONFIGURED),
    );
  }

  delete(_path: string): Promise<void> {
    return Promise.resolve();
  }
}
