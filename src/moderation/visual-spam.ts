import type { ConfigSnapshot } from "../types.js";

export interface VisualSpamAnalysis {
  visibleCharacterCount: number;
  lineCount: number;
  longestLineLength: number;
  symbolDensityRatio: number;
  longestDenseSymbolRun: number;
  repeatedVisualLineCount: number;
  naturalWordRatio: number;
  score: number;
  highConfidence: boolean;
  borderline: boolean;
}

function countVisibleCharacters(text: string): number {
  return [...text].filter((character) => !/\s/u.test(character)).length;
}

function countNaturalWords(text: string): number {
  return (text.match(/\b[\p{L}]{2,}\b/gu) ?? []).length;
}

function countSymbolCharacters(text: string): number {
  return [...text].filter((character) => /[^\p{L}\p{N}\s]/u.test(character)).length;
}

function longestDenseSymbolRun(text: string): number {
  let longest = 0;
  let current = 0;

  for (const character of text) {
    if (/[^\p{L}\p{N}\s]/u.test(character)) {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }

    current = 0;
  }

  return longest;
}

function countRepeatedVisualLines(lines: string[], minimumSymbolDensity: number): number {
  const counts = new Map<string, number>();
  // Use a lower threshold than the message-level density check so that
  // individual lines with moderate symbol content still get counted.
  const lineSymbolDensityThreshold = minimumSymbolDensity * 0.78;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length < 6) {
      continue;
    }

    const normalized = trimmed.replace(/\s+/gu, " ");
    const symbolDensity =
      countVisibleCharacters(normalized) === 0
        ? 0
        : countSymbolCharacters(normalized) / countVisibleCharacters(normalized);

    if (symbolDensity < lineSymbolDensityThreshold) {
      continue;
    }

    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return Math.max(0, ...counts.values());
}

export function analyzeVisualSpam(
  text: string,
  config: ConfigSnapshot["moderationPolicy"]["deterministicRules"]["visualSpam"],
): VisualSpamAnalysis {
  const lines = text.split(/\r?\n/u);
  const visibleCharacterCount = countVisibleCharacters(text);
  const lineCount = lines.filter((line) => line.trim().length > 0).length;
  const longestLineLength = Math.max(0, ...lines.map((line) => line.length));
  const symbolCharacters = countSymbolCharacters(text);
  const symbolDensityRatio = visibleCharacterCount === 0 ? 0 : symbolCharacters / visibleCharacterCount;
  const denseSymbolRun = longestDenseSymbolRun(text);
  const repeatedVisualLineCount = countRepeatedVisualLines(lines, config.minimumSymbolDensity);
  const naturalWords = countNaturalWords(text);
  const totalTokens = Math.max(1, (text.match(/\S+/gu) ?? []).length);
  const naturalWordRatio = naturalWords / totalTokens;

  let score = 0;

  if (visibleCharacterCount >= config.minimumVisibleCharacters) {
    score += 1;
  }

  if (lineCount >= config.minimumLineCount) {
    score += 1;
  }

  if (longestLineLength >= config.minimumLongestLineLength) {
    score += 1;
  }

  if (denseSymbolRun >= config.minimumDenseSymbolRunLength) {
    score += 1;
  }

  if (repeatedVisualLineCount >= config.minimumRepeatedVisualLines) {
    score += 1;
  }

  if (symbolDensityRatio >= config.minimumSymbolDensity) {
    score += 2;
  }

  if (symbolDensityRatio >= config.minimumSymbolDensity + 0.15) {
    score += 1;
  }

  if (naturalWordRatio <= config.maximumNaturalWordRatio) {
    score += 1;
  }

  if (lineCount >= config.minimumLineCount + 1 && longestLineLength >= config.minimumLongestLineLength) {
    score += 1;
  }

  const highConfidence =
    config.enabled &&
    score >= config.minimumHighConfidenceScore &&
    visibleCharacterCount >= config.minimumVisibleCharacters &&
    symbolDensityRatio >= config.minimumSymbolDensity &&
    naturalWordRatio <= config.maximumNaturalWordRatio &&
    (lineCount >= config.minimumLineCount || longestLineLength >= config.minimumLongestLineLength * 2);

  const borderline =
    config.enabled &&
    !highConfidence &&
    score >= config.minimumBorderlineScore &&
    symbolDensityRatio >= config.minimumSymbolDensity * 0.8 &&
    visibleCharacterCount >= Math.max(12, Math.floor(config.minimumVisibleCharacters / 2));

  return {
    visibleCharacterCount,
    lineCount,
    longestLineLength,
    symbolDensityRatio,
    longestDenseSymbolRun: denseSymbolRun,
    repeatedVisualLineCount,
    naturalWordRatio,
    score,
    highConfidence,
    borderline,
  };
}
