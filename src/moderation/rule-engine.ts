import type { ConfigSnapshot, NormalizedChatMessage, ProposedAction, RuleDecision } from "../types.js";
import { CooldownManager } from "./cooldown-manager.js";
import { analyzeVisualSpam } from "./visual-spam.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function longestRepeatedRun(text: string): number {
  let longest = 0;
  let current = 0;
  let previous = "";

  for (const character of text) {
    if (character === previous) {
      current += 1;
    } else {
      previous = character;
      current = 1;
    }

    if (current > longest) {
      longest = current;
    }
  }

  return longest;
}

export class RuleEngine {
  private readonly blockedTermMatchers: Array<{ term: string; matcher: RegExp }>;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly cooldowns: CooldownManager,
    private readonly isUserExempt?: (login: string) => boolean,
    private readonly getRuntimeBlockedTerms?: () => Array<{ term: string }>,
  ) {
    this.blockedTermMatchers = this.config.moderationPolicy.deterministicRules.blockedTerms
      .map((term) => term.trim())
      .filter(Boolean)
      .map((term) => ({
        term,
        matcher: new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`, "iu"),
      }));
  }

  public evaluate(message: NormalizedChatMessage, now = Date.now()): RuleDecision {
    if (message.isPrivileged) {
      return {
        source: "rules",
        outcome: "no_action",
        reason: "privileged chatter exempt from deterministic moderation",
        actions: [],
      };
    }

    if (this.isUserExempt?.(message.chatterLogin)) {
      return {
        source: "rules",
        outcome: "no_action",
        reason: "user exempt from moderation by runtime exemption",
        actions: [],
      };
    }

    const blockedTermMatch = this.findBlockedTerm(message.normalizedText);

    if (blockedTermMatch && this.config.moderationPolicy.deterministicRules.escalationThresholds.timeoutOnBlockedTerm) {
      return this.buildTimeoutDecision(message, "blocked_term", `matched blocked term: ${blockedTermMatch}`, now, {
        blockedTerm: blockedTermMatch,
      });
    }

    const spamSignals = this.detectSpamSignals(message);

    if (spamSignals.length > 0 && this.config.moderationPolicy.deterministicRules.escalationThresholds.timeoutOnSpam) {
      return this.buildTimeoutDecision(message, "spam_heuristic", `spam heuristics matched: ${spamSignals.join(", ")}`, now, {
        spamSignals,
      });
    }

    const visualSpamAnalysis = analyzeVisualSpam(message.text, this.config.moderationPolicy.deterministicRules.visualSpam);

    if (visualSpamAnalysis.highConfidence) {
      return this.buildTimeoutDecision(
        message,
        "visual_spam_ascii_art",
        "large disruptive ASCII art or visual spam",
        now,
        {
          visualSpamAnalysis,
        },
      );
    }

    return {
      source: "rules",
      outcome: "no_action",
      reason: "no deterministic rule matched",
      actions: [],
    };
  }

  private buildTimeoutDecision(
    message: NormalizedChatMessage,
    matchedRule: string,
    reason: string,
    now: number,
    metadata?: Record<string, unknown>,
  ): RuleDecision {
    const moderationGate = this.cooldowns.canModerateUser(message.chatterId, "timeout", now);

    if (!moderationGate.allowed) {
      return {
        source: "rules",
        outcome: "suppressed",
        reason: moderationGate.reason ?? "moderation cooldown active",
        matchedRule,
        actions: [],
        ...(metadata ? { metadata } : {}),
      };
    }

    const action: ProposedAction = {
      kind: "timeout",
      reason,
      targetUserId: message.chatterId,
      targetUserName: message.chatterLogin,
      durationSeconds: this.config.moderationPolicy.deterministicRules.timeoutSeconds,
      ...(metadata ? { metadata } : {}),
    };
    const warn: ProposedAction = {
      kind: "warn",
      reason: `${matchedRule} public notice`,
      message: this.getPublicNoticeTemplate(matchedRule),
      targetUserId: message.chatterId,
      targetUserName: message.chatterLogin,
      replyParentMessageId: message.sourceMessageId,
      metadata: {
        timeoutCompanion: true,
        timeoutRule: matchedRule,
      },
    };

    return {
      source: "rules",
      outcome: "action",
      reason,
      matchedRule,
      actions: [action, warn],
      ...(metadata ? { metadata } : {}),
    };
  }

  private getPublicNoticeTemplate(matchedRule: string): string {
    switch (matchedRule) {
      case "blocked_term":
        return this.config.moderationPolicy.publicNotices.blockedTerm;
      case "spam_heuristic":
        return this.config.moderationPolicy.publicNotices.spamHeuristic;
      case "visual_spam_ascii_art":
        return this.config.moderationPolicy.publicNotices.visualSpamAsciiArt;
      default:
        return this.config.moderationPolicy.publicNotices.generic;
    }
  }

  private findBlockedTerm(text: string): string | null {
    const lowerText = text.toLowerCase();

    for (const entry of this.blockedTermMatchers) {
      if (entry.matcher.test(lowerText)) {
        return entry.term;
      }
    }

    const runtimeTerms = this.getRuntimeBlockedTerms?.() ?? [];
    for (const entry of runtimeTerms) {
      const matcher = new RegExp(`\\b${escapeRegExp(entry.term.toLowerCase())}\\b`, "iu");
      if (matcher.test(lowerText)) {
        return entry.term;
      }
    }

    return null;
  }

  private detectSpamSignals(message: NormalizedChatMessage): string[] {
    const spamSignals: string[] = [];
    const repeatedRun = longestRepeatedRun(message.normalizedText);
    const emoteCount = message.parts.filter((part) => part.type === "emote").length;
    const mentionCount = message.parts.filter((part) => part.type === "mention").length;

    if (repeatedRun >= this.config.moderationPolicy.deterministicRules.spam.maxRepeatedCharacters) {
      spamSignals.push(`repeated_characters:${repeatedRun}`);
    }

    if (emoteCount >= this.config.moderationPolicy.deterministicRules.spam.maxEmotesPerMessage) {
      spamSignals.push(`emotes:${emoteCount}`);
    }

    if (mentionCount >= this.config.moderationPolicy.deterministicRules.spam.maxMentionsPerMessage) {
      spamSignals.push(`mentions:${mentionCount}`);
    }

    return spamSignals;
  }
}
