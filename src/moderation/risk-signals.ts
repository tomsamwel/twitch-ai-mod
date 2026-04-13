import type { NormalizedChatMessage } from "../types.js";
import { countMentions } from "../utils.js";

export const CAPS_RATIO_THRESHOLD = 0.7;
export const CAPS_MIN_ALPHA = 8;
export const MENTION_COUNT_THRESHOLD = 3;
export const LENGTH_THRESHOLD = 400;

export function isHighCaps(text: string): boolean {
  let upper = 0;
  let alpha = 0;
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") { upper++; alpha++; }
    else if (ch >= "a" && ch <= "z") { alpha++; }
  }
  return alpha >= CAPS_MIN_ALPHA && upper / alpha > CAPS_RATIO_THRESHOLD;
}

/** Check if a message has risk signals (URLs, excessive caps, many mentions, long text). */
export function hasRiskSignals(message: NormalizedChatMessage): boolean {
  const text = message.normalizedText ?? message.text;
  if (message.urlResult.detected) return true;
  // Caps detection uses raw text since normalizedText is lowercased
  if (isHighCaps(message.text)) return true;
  if (countMentions(message) >= MENTION_COUNT_THRESHOLD) return true;
  if (text.length > LENGTH_THRESHOLD) return true;
  if (hasPhraseRepetition(text)) return true;
  return false;
}

/** Check if a message contains repeated phrases (copypasta detection). */
export function hasPhraseRepetition(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 12) return false; // need enough words for 3 repetitions of a 4-gram
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - 4; i++) {
    const gram = words.slice(i, i + 4).join(" ");
    const c = (counts.get(gram) ?? 0) + 1;
    counts.set(gram, c);
    if (c >= 3) return true;
  }
  return false;
}

/** Score message risk (higher = riskier). Used for queue coalescing. */
export function messageRiskScore(message: NormalizedChatMessage): number {
  const text = message.normalizedText ?? message.text;
  let score = 0;
  if (message.urlResult.detected) score += 4;
  // Caps detection uses raw text since normalizedText is lowercased
  if (isHighCaps(message.text)) score += 3;
  if (countMentions(message) >= MENTION_COUNT_THRESHOLD) score += 2;
  if (text.length > LENGTH_THRESHOLD) score += 1;
  return score;
}
