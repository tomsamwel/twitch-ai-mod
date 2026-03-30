/**
 * URL/link detection for AI context signals.
 *
 * Detects standard URLs, bare domains, obfuscated links, and IP addresses.
 * Used as a signal for AI review, not for auto-moderation (links can be
 * legitimate clip shares, social media, etc.).
 */

export interface UrlDetectionResult {
  detected: boolean;
  urls: string[];
  obfuscated: boolean;
}

const COMMON_TLDS = [
  "com", "net", "org", "io", "gg", "tv", "ly", "me", "co",
  "xyz", "link", "click", "info", "ru", "cn", "cc", "tk",
  "dev", "app", "site", "online", "store", "shop",
];

/** Standard URLs: http:// or https:// followed by non-whitespace. */
const STANDARD_URL_RE = /https?:\/\/[^\s]+/gi;

/** Bare domains: word.tld optionally followed by a path. */
const BARE_DOMAIN_RE = new RegExp(
  `\\b[a-z0-9][-a-z0-9]*\\.(?:${COMMON_TLDS.join("|")})\\b(?:\\/[^\\s]*)?`,
  "gi",
);

/** IP address URLs: digits.digits.digits.digits optionally with port/path. */
const IP_URL_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s]*)?\b/g;

/**
 * Obfuscated domain patterns:
 * - "dot com", "d0t com", "(dot)", "[dot]"
 * - Spaced: ". com", " .com"
 */
const OBFUSCATED_DOT_RE = new RegExp(
  `\\b[a-z0-9][-a-z0-9]*\\s*(?:dot|d0t|\\(dot\\)|\\[dot\\]|\\s\\.)\\s*(?:${COMMON_TLDS.join("|")})\\b`,
  "gi",
);

/**
 * Filters out shorter matches that are substrings of longer matches.
 * E.g., "example.com" is dropped when "https://example.com/path" is present.
 */
function deduplicate(urls: string[]): string[] {
  const trimmed = urls.map((u) => u.trim());
  const lowered = trimmed.map((u) => u.toLowerCase());
  const result: string[] = [];
  const seen = new Set<string>();

  // Sort longest first so we keep the longest match.
  const indexed = lowered.map((l, i) => ({ lower: l, index: i }));
  indexed.sort((a, b) => b.lower.length - a.lower.length);

  for (const { lower, index } of indexed) {
    // Skip if this URL is a substring of an already-accepted URL.
    let isSubstring = false;
    for (const accepted of seen) {
      if (accepted.includes(lower)) {
        isSubstring = true;
        break;
      }
    }

    if (!isSubstring && !seen.has(lower)) {
      seen.add(lower);
      result.push(trimmed[index]!);
    }
  }

  return result;
}

export function detectUrls(text: string): UrlDetectionResult {
  const standardMatches = text.match(STANDARD_URL_RE) ?? [];
  const bareMatches = text.match(BARE_DOMAIN_RE) ?? [];
  const ipMatches = text.match(IP_URL_RE) ?? [];
  const obfuscatedMatches = text.match(OBFUSCATED_DOT_RE) ?? [];

  const allUrls = deduplicate([...standardMatches, ...bareMatches, ...ipMatches, ...obfuscatedMatches]);

  return {
    detected: allUrls.length > 0,
    urls: allUrls,
    obfuscated: obfuscatedMatches.length > 0,
  };
}
