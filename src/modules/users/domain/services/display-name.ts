export const DISPLAY_NAME_MAX_LENGTH = 100;
// The column holds 255 characters (code points). A hundred "family" emoji look like 100
// characters but are 500 code points, so the stored size is limited as well.
const DISPLAY_NAME_MAX_CODE_POINTS = 200;

const segmenter = new Intl.Segmenter();
const lengthInCharacters = (text: string) =>
  [...segmenter.segment(text)].length;

// Characters that show nothing or change how text reads: zero-width spaces, fillers (Hangul,
// Braille blank), text-direction switches, soft hyphen, variation selectors, joiners...
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}⠀]/gu;
// The two joiners and the emoji variation selectors are needed inside real text (Persian
// "می‌خواهم", Hindi conjuncts, family and flag emoji, ❤️), so they stay when they sit between
// letters, marks or emoji, and go anywhere else
const JOINER_KEEP = '‌‍';
const VARIATION_KEEP = '︎️';
const INSIDE_TEXT = String.raw`\p{L}\p{M}\p{Extended_Pictographic}`;
const STRAY_JOINER = new RegExp(
  `(?<![${INSIDE_TEXT}])[${JOINER_KEEP}]|[${JOINER_KEEP}](?![${INSIDE_TEXT}])`,
  'gu',
);
const STRAY_VARIATION = new RegExp(
  `(?<!\\p{Extended_Pictographic})[${VARIATION_KEEP}]`,
  'gu',
);
// Something a person can read as a name
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * The name as it will be stored, or null when nothing visible is left or it is too long.
 * Line breaks and other control characters become a space, invisible characters are dropped,
 * repeated spaces collapse into one and both ends are trimmed. The length counts what a person
 * sees as one character (a flag or a family emoji is one).
 */
export function normalizeDisplayName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\p{Co}\p{Cs}]/gu, '')
    .replace(INVISIBLE, (character) =>
      JOINER_KEEP.includes(character) || VARIATION_KEEP.includes(character)
        ? character
        : '',
    )
    .replace(STRAY_JOINER, '')
    .replace(STRAY_VARIATION, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();

  if (
    !VISIBLE.test(cleaned) ||
    lengthInCharacters(cleaned) > DISPLAY_NAME_MAX_LENGTH ||
    [...cleaned].length > DISPLAY_NAME_MAX_CODE_POINTS
  ) {
    return null;
  }
  return cleaned;
}
