import { analyzeVisualSpam } from "../moderation/visual-spam.js";
import type { AiContextSnapshot, AiDecision, ConfigSnapshot, NormalizedChatMessage } from "../types.js";

const CLEAN_DEESCALATION_GUARDRAIL_ID = "clean-deescalation-followup";
const MAX_DEESCALATION_TOKENS = 12;

const CLEAN_DEESCALATION_ALLOWED_TOKENS = new Set([
  "a",
  "alright",
  "be",
  "btw",
  "enough",
  "fair",
  "good",
  "got",
  "great",
  "have",
  "ill",
  "it",
  "kind",
  "my",
  "bad",
  "fault",
  "nice",
  "noted",
  "okay",
  "ok",
  "one",
  "sorry",
  "sry",
  "stop",
  "stream",
  "thank",
  "thanks",
  "understood",
  "wont",
  "you",
  "again",
  "happen",
  "chill",
]);

const CLEAN_DEESCALATION_CORE_PHRASES = [
  "fair enough",
  "got it",
  "ill be kind",
  "ill chill",
  "ill stop",
  "my bad",
  "my fault",
  "noted",
  "okay sorry",
  "ok sorry",
  "sorry",
  "sry",
  "understood",
  "wont happen again",
] as const;

function normalizeForGuardrails(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/['\u2019]/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

function hasRecentConversationHistory(context: AiContextSnapshot): boolean {
  return context.recentUserMessages.length > 0 || context.recentBotInteractions.length > 0;
}

function hasCurrentMessageRiskSignals(message: NormalizedChatMessage, config: ConfigSnapshot): boolean {
  if (message.urlResult.detected) {
    return true;
  }

  const visualSpam = analyzeVisualSpam(message.text, config.moderationPolicy.deterministicRules.visualSpam);
  return visualSpam.highConfidence || visualSpam.borderline;
}

function matchesCleanDeescalationLanguage(message: NormalizedChatMessage): boolean {
  const normalized = normalizeForGuardrails(message.text);
  if (!normalized) {
    return false;
  }

  const tokens = normalized.split(" ");
  if (tokens.length > MAX_DEESCALATION_TOKENS) {
    return false;
  }

  if (!CLEAN_DEESCALATION_CORE_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return false;
  }

  return tokens.every((token) => CLEAN_DEESCALATION_ALLOWED_TOKENS.has(token));
}

function isCleanDeescalationFollowup(
  message: NormalizedChatMessage,
  context: AiContextSnapshot,
  config: ConfigSnapshot,
): boolean {
  return (
    hasRecentConversationHistory(context) &&
    !hasCurrentMessageRiskSignals(message, config) &&
    matchesCleanDeescalationLanguage(message)
  );
}

export function applyAiDecisionGuardrails(
  decision: AiDecision,
  message: NormalizedChatMessage,
  context: AiContextSnapshot,
  config: ConfigSnapshot,
): AiDecision {
  if (decision.mode !== "moderation" || decision.outcome !== "action") {
    return decision;
  }

  if (!isCleanDeescalationFollowup(message, context, config)) {
    return decision;
  }

  return {
    ...decision,
    outcome: "abstain",
    reason: "clean de-escalation follow-up",
    confidence: 0,
    moderationCategory: "none",
    actions: [],
    metadata: {
      ...(decision.metadata ?? {}),
      guardrail: {
        id: CLEAN_DEESCALATION_GUARDRAIL_ID,
        originalOutcome: decision.outcome,
        originalReason: decision.reason,
        originalConfidence: decision.confidence,
        originalModerationCategory: decision.moderationCategory,
        originalActionKinds: decision.actions.map((action) => action.kind),
      },
    },
  };
}
