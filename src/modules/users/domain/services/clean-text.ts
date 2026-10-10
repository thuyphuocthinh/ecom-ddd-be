const segmenter = new Intl.Segmenter();

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

/** The number of characters a person sees (a flag or a family emoji counts as one). */
export const lengthInCharacters = (text: string) =>
  [...segmenter.segment(text)].length;

/** Whether there is something a person can read in the text (not only spaces or invisible marks). */
export const hasVisibleCharacter = (text: string) => VISIBLE.test(text);

/**
 * Tidies free text typed by a person: line breaks and other control characters become a space,
 * invisible characters are dropped, repeated spaces collapse into one, both ends are trimmed.
 */
export function cleanText(raw: string): string {
  return raw
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
}
