import {
  cleanText,
  hasVisibleCharacter,
  lengthInCharacters,
} from './clean-text.js';

export const DISPLAY_NAME_MAX_LENGTH = 100;
// The column holds 255 characters (code points). A hundred "family" emoji look like 100
// characters but are 500 code points, so the stored size is limited as well.
const DISPLAY_NAME_MAX_CODE_POINTS = 200;

/**
 * The name as it will be stored, or null when nothing visible is left or it is too long.
 * Line breaks and other control characters become a space, invisible characters are dropped,
 * repeated spaces collapse into one and both ends are trimmed. The length counts what a person
 * sees as one character (a flag or a family emoji is one).
 */
export function normalizeDisplayName(raw: string): string | null {
  const cleaned = cleanText(raw);

  if (
    !hasVisibleCharacter(cleaned) ||
    lengthInCharacters(cleaned) > DISPLAY_NAME_MAX_LENGTH ||
    [...cleaned].length > DISPLAY_NAME_MAX_CODE_POINTS
  ) {
    return null;
  }
  return cleaned;
}
