/**
 * Unicode normalization for anti-evasion.
 *
 * Strips zero-width characters, maps Cyrillic/Greek/fullwidth homoglyphs
 * to their Latin equivalents, and applies NFC normalization. Used by the
 * rule engine so keyword filters cannot be bypassed with character swaps.
 */

/** Zero-width and invisible characters that should be stripped entirely. */
const INVISIBLE_CODEPOINTS = new Set([
  0x00ad, // soft hyphen
  0x034f, // combining grapheme joiner
  0x061c, // arabic letter mark
  0x180e, // mongolian vowel separator
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override (used to reverse text)
  0x2060, // word joiner
  0x2061, // function application
  0x2062, // invisible times
  0x2063, // invisible separator
  0x2064, // invisible plus
  0xfeff, // byte order mark / zero-width no-break space
]);

/**
 * Confusable character map: visually identical non-Latin characters to Latin.
 * Only includes characters that are genuinely indistinguishable in typical
 * Twitch chat fonts. Conservative to avoid false positives.
 */
const CONFUSABLE_MAP = new Map<number, number>([
  // Cyrillic lowercase
  [0x0430, 0x61], // а → a
  [0x0441, 0x63], // с → c
  [0x0501, 0x64], // ԁ → d
  [0x0435, 0x65], // е → e
  [0x04bb, 0x68], // һ → h
  [0x0456, 0x69], // і → i
  [0x0458, 0x6a], // ј → j
  [0x043e, 0x6f], // о → o
  [0x0440, 0x70], // р → p
  [0x051b, 0x71], // ԛ → q
  [0x0455, 0x73], // ѕ → s
  [0x051d, 0x77], // ԝ → w
  [0x0445, 0x78], // х → x
  [0x0443, 0x79], // у → y

  // Cyrillic uppercase
  [0x0410, 0x41], // А → A
  [0x0412, 0x42], // В → B
  [0x0421, 0x43], // С → C
  [0x0415, 0x45], // Е → E
  [0x041d, 0x48], // Н → H
  [0x0406, 0x49], // І → I
  [0x0408, 0x4a], // Ј → J
  [0x041a, 0x4b], // К → K
  [0x041c, 0x4d], // М → M
  [0x041e, 0x4f], // О → O
  [0x0420, 0x50], // Р → P
  [0x0405, 0x53], // Ѕ → S
  [0x0422, 0x54], // Т → T
  [0x0425, 0x58], // Х → X
  [0x0423, 0x59], // У → Y

  // Greek lowercase
  [0x03bf, 0x6f], // ο → o
  [0x03b1, 0x61], // α → a (close enough in sans-serif)

  // Greek uppercase
  [0x0391, 0x41], // Α → A
  [0x0392, 0x42], // Β → B
  [0x0395, 0x45], // Ε → E
  [0x0397, 0x48], // Η → H
  [0x0399, 0x49], // Ι → I
  [0x039a, 0x4b], // Κ → K
  [0x039c, 0x4d], // Μ → M
  [0x039d, 0x4e], // Ν → N
  [0x039f, 0x4f], // Ο → O
  [0x03a1, 0x50], // Ρ → P
  [0x03a4, 0x54], // Τ → T
  [0x03a7, 0x58], // Χ → X
  [0x03a5, 0x59], // Υ → Y
  [0x0396, 0x5a], // Ζ → Z
]);

/**
 * Fullwidth Latin range: U+FF01 to U+FF5E map to U+0021 to U+007E.
 * Subtract 0xFEE0 from the codepoint.
 */
const FULLWIDTH_START = 0xff01;
const FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;

export function normalizeUnicode(text: string): string {
  let result = "";

  for (const char of text) {
    const cp = char.codePointAt(0)!;

    // Strip invisible characters
    if (INVISIBLE_CODEPOINTS.has(cp)) {
      continue;
    }

    // Fullwidth Latin → ASCII
    if (cp >= FULLWIDTH_START && cp <= FULLWIDTH_END) {
      result += String.fromCodePoint(cp - FULLWIDTH_OFFSET);
      continue;
    }

    // Confusable homoglyphs → Latin
    const mapped = CONFUSABLE_MAP.get(cp);
    if (mapped !== undefined) {
      result += String.fromCodePoint(mapped);
      continue;
    }

    result += char;
  }

  return result.normalize("NFC");
}
