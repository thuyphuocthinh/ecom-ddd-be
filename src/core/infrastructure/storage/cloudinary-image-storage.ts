import { Logger } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { DomainException } from '../../domain/exceptions/domain.exception.js';
import { StorageErrorCodes } from '../../domain/exceptions/error-codes.js';
import type {
  IImageStorage,
  ImageFit,
  ImageType,
  ImageUpload,
} from './image-storage.port.js';

export interface CloudinarySettings {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Everything of this app lives under this folder of the Cloudinary account. */
  folder: string;
}

/** The two calls to Cloudinary that are needed; a stand-in replaces them in tests. */
export interface CloudinaryClient {
  upload(
    image: Buffer,
    options: Record<string, unknown>,
  ): Promise<{ secure_url?: string }>;
  destroy(publicId: string, options: Record<string, unknown>): Promise<unknown>;
}

const UPLOAD_TIMEOUT_MS = 15_000;
// Cloudinary answers 400 for a file it cannot read as an image
const CLOUDINARY_BAD_IMAGE = 400;
// Names separated by single slashes; keeps a caller from reaching outside its folder
const PATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export const DEFAULT_IMAGE_FOLDER = 'ecom';

/** The real Cloudinary, using the official SDK; nothing is written to disk. */
export function createCloudinaryClient(
  settings: CloudinarySettings,
): CloudinaryClient {
  cloudinary.config({
    cloud_name: settings.cloudName,
    api_key: settings.apiKey,
    api_secret: settings.apiSecret,
    secure: true,
  });
  return {
    upload: (image, options) =>
      new Promise((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(options, (error, result) =>
            error || !result
              ? reject(error ?? new Error('Cloudinary gave no result'))
              : resolve(result),
          )
          .end(image);
      }),
    destroy: (publicId, options) =>
      cloudinary.uploader.destroy(publicId, options),
  };
}

export class CloudinaryImageStorage implements IImageStorage {
  private readonly logger = new Logger(CloudinaryImageStorage.name);
  private readonly addressStart: string;

  constructor(
    private readonly settings: CloudinarySettings,
    private readonly client: CloudinaryClient = createCloudinaryClient(
      settings,
    ),
  ) {
    this.addressStart = `https://res.cloudinary.com/${settings.cloudName}/`;
  }

  async upload(request: ImageUpload): Promise<string> {
    const publicId = this.publicId(request.path);
    let result: { secure_url?: string };
    try {
      result = await this.client.upload(request.image, {
        public_id: publicId,
        resource_type: 'image',
        // Uploading to the same path again replaces the picture instead of piling up files
        overwrite: true,
        invalidate: true,
        unique_filename: false,
        use_filename: false,
        // Cloudinary checks the file again on its side
        allowed_formats: [formatName(request.type)],
        transformation: [transformationFor(request.fit)],
        timeout: UPLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      if (
        (error as { http_code?: number })?.http_code === CLOUDINARY_BAD_IMAGE
      ) {
        // Usually the file, but a bad option on our side looks the same: leave a trace
        this.logger.warn(
          `Cloudinary refused an image as unreadable: ${reasonOf(error)}`,
        );
        throw new DomainException(StorageErrorCodes.UNREADABLE_IMAGE);
      }
      // Only what went wrong, never the file or the keys
      this.logger.error(`Uploading an image failed: ${reasonOf(error)}`);
      throw new DomainException(StorageErrorCodes.UNAVAILABLE);
    }

    const address = result.secure_url;
    if (typeof address !== 'string' || !address.startsWith(this.addressStart)) {
      this.logger.error(
        'Cloudinary answered with an address outside the configured cloud',
      );
      throw new DomainException(StorageErrorCodes.UNAVAILABLE);
    }
    return address;
  }

  async delete(path: string): Promise<void> {
    const publicId = this.publicId(path);
    try {
      await this.client.destroy(publicId, {
        invalidate: true,
        timeout: UPLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.error(`Removing an image failed: ${reasonOf(error)}`);
      throw new DomainException(StorageErrorCodes.UNAVAILABLE);
    }
  }

  private publicId(path: string): string {
    if (!PATH_PATTERN.test(path)) {
      // A bug in the calling code, not something a user can cause
      throw new Error(`Invalid image path "${path}"`);
    }
    return `${this.settings.folder}/${path}`;
  }
}

function formatName(type: ImageType): string {
  return type === 'jpeg' ? 'jpg' : type;
}

function transformationFor(fit: ImageFit): Record<string, unknown> {
  return {
    width: fit.width,
    height: fit.height,
    crop: fit.crop,
    ...(fit.crop === 'fill' && fit.focus === 'face' && { gravity: 'face' }),
    quality: 'auto',
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'unknown error';
}
