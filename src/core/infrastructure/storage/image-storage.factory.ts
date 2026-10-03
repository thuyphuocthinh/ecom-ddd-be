import type { IImageStorage } from './image-storage.port.js';
import {
  CloudinaryImageStorage,
  DEFAULT_IMAGE_FOLDER,
  type CloudinarySettings,
} from './cloudinary-image-storage.js';
import { UnconfiguredImageStorage } from './unconfigured-image-storage.js';

/** The Cloudinary settings, or null when none are given (`validateEnv` makes sure it is all or none). */
export function cloudinarySettingsFromEnv(
  env: NodeJS.ProcessEnv,
): CloudinarySettings | null {
  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: env.CLOUDINARY_FOLDER?.trim() || DEFAULT_IMAGE_FOLDER,
  };
}

export function createImageStorage(env: NodeJS.ProcessEnv): IImageStorage {
  const settings = cloudinarySettingsFromEnv(env);
  return settings
    ? new CloudinaryImageStorage(settings)
    : new UnconfiguredImageStorage();
}
