import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUnicode } from "../src/moderation/unicode-normalize.js";

test("normalizeUnicode passes through plain ASCII unchanged", () => {
  assert.equal(normalizeUnicode("hello world"), "hello world");
});

test("normalizeUnicode strips zero-width space", () => {
  assert.equal(normalizeUnicode("buy\u200Bfollowers"), "buyfollowers");
});

test("normalizeUnicode strips zero-width joiner and BOM", () => {
  assert.equal(normalizeUnicode("kys\u200D\uFEFF"), "kys");
});

test("normalizeUnicode strips soft hyphen", () => {
  assert.equal(normalizeUnicode("view\u00ADer bot"), "viewer bot");
});

test("normalizeUnicode strips RTL override (U+202E)", () => {
  assert.equal(normalizeUnicode("buy \u202Efollowers"), "buy followers");
});

test("normalizeUnicode maps Cyrillic lowercase homoglyphs to Latin", () => {
  // "buу fоllоwеrs" with Cyrillic у (0x0443), о (0x043E), е (0x0435)
  const evasion = "bu\u0443 f\u043Ell\u043Ew\u0435rs";
  assert.equal(normalizeUnicode(evasion), "buy followers");
});

test("normalizeUnicode maps Cyrillic uppercase homoglyphs to Latin", () => {
  // "ВUY" with Cyrillic В (0x0412)
  assert.equal(normalizeUnicode("\u0412UY"), "BUY");
});

test("normalizeUnicode maps Cyrillic а and с", () => {
  // "scam" with Cyrillic с (0x0441) and а (0x0430)
  assert.equal(normalizeUnicode("\u0441c\u0430m"), "ccam");
});

test("normalizeUnicode converts fullwidth Latin to ASCII", () => {
  // ｂｕｙ = fullwidth b, u, y
  assert.equal(normalizeUnicode("\uFF42\uFF55\uFF59"), "buy");
});

test("normalizeUnicode converts fullwidth punctuation", () => {
  // ！ = fullwidth exclamation mark
  assert.equal(normalizeUnicode("hello\uFF01"), "hello!");
});

test("normalizeUnicode handles mixed evasion: Cyrillic + zero-width", () => {
  // "k\u200Dy\u200Bs" with zero-width chars = "kys" after stripping
  // then "vi\u0435wer" with Cyrillic е = "viewer"
  assert.equal(normalizeUnicode("k\u200Dy\u200Bs"), "kys");
  assert.equal(normalizeUnicode("vi\u0435wer"), "viewer");
});

test("normalizeUnicode maps Greek uppercase homoglyphs", () => {
  // Greek Α (0x0391) → A, Β (0x0392) → B
  assert.equal(normalizeUnicode("\u0391\u0392C"), "ABC");
});

test("normalizeUnicode preserves emoji", () => {
  assert.equal(normalizeUnicode("hello 😊 world"), "hello 😊 world");
  assert.equal(normalizeUnicode("🎮 gaming"), "🎮 gaming");
});

test("normalizeUnicode preserves CJK and other non-confusable scripts", () => {
  assert.equal(normalizeUnicode("日本語テスト"), "日本語テスト");
});

test("normalizeUnicode handles empty string", () => {
  assert.equal(normalizeUnicode(""), "");
});

test("normalizeUnicode applies NFC normalization", () => {
  // e + combining acute accent (two codepoints) → é (one codepoint via NFC)
  const decomposed = "caf\u0065\u0301";
  const result = normalizeUnicode(decomposed);
  assert.equal(result, "café");
});

test("normalizeUnicode handles complex evasion of blocked term 'buy followers'", () => {
  // Mix of: Cyrillic о (0x043E), zero-width space, fullwidth l (0xFF4C)
  const evasion = "buy f\u043E\u200B\uFF4C\uFF4Cowers";
  assert.equal(normalizeUnicode(evasion), "buy followers");
});
