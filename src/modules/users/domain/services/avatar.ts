import type { ImageFit } from '@/core/index.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// Pictures are shown small; a square around the face keeps them light and uniform
export const AVATAR_FIT: ImageFit = {
  width: 256,
  height: 256,
  crop: 'fill',
  focus: 'face',
};

/** One fixed place per user, so a new picture replaces the old one. */
export const avatarPath = (userId: string): string => `avatars/${userId}`;

/** The name of the lock that makes changes to one user's avatar take turns. */
export const avatarLock = (userId: string): string => `avatar:${userId}`;
