import type { GoogleIdentity } from '../../domain/index.js';

const DISPLAY_NAME_MAX_LENGTH = 255;
const AVATAR_URL_MAX_LENGTH = 500;

/**
 * The name and picture Google gives, cut to what the database holds: a blank name becomes
 * nothing, and a picture is only taken over https and when it fits.
 */
export function profileOf(identity: GoogleIdentity): {
  displayName: string | null;
  avatarUrl: string | null;
} {
  const name = identity.name?.trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
  const picture = identity.picture?.trim();
  return {
    displayName: name || null,
    avatarUrl:
      picture &&
      picture.startsWith('https://') &&
      picture.length <= AVATAR_URL_MAX_LENGTH
        ? picture
        : null,
  };
}
