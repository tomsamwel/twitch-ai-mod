import type { CoalesceResult, Priority } from "./ai-review-queue.js";
import type { AiReviewWorkItem } from "./message-processor.js";
import type { NormalizedChatMessage } from "../types.js";
import { detectUrls } from "../moderation/url-detect.js";
import { countMentions } from "../utils.js";

export const CAPS_RATIO_THRESHOLD = 0.7;
export const CAPS_MIN_ALPHA = 8;
export const MENTION_COUNT_THRESHOLD = 3;
export const LENGTH_THRESHOLD = 400;
export const REPEAT_OFFENDER_WINDOW_MS = 3_600_000;

export interface PriorityClassifierDeps {
  countRecentTimeoutsForUser(targetUserId: string, afterTimestamp: string): number;
}

function isHighCaps(text: string): boolean {
  let upper = 0;
  let alpha = 0;
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") { upper++; alpha++; }
    else if (ch >= "a" && ch <= "z") { alpha++; }
  }
  return alpha >= CAPS_MIN_ALPHA && upper / alpha > CAPS_RATIO_THRESHOLD;
}

function hasRiskSignals(message: NormalizedChatMessage): boolean {
  if (detectUrls(message.text).detected) return true;
  if (isHighCaps(message.text)) return true;
  if (countMentions(message) >= MENTION_COUNT_THRESHOLD) return true;
  if (message.text.length > LENGTH_THRESHOLD) return true;
  return false;
}

function hasTrustSignals(message: NormalizedChatMessage): boolean {
  if (message.roles.includes("subscriber")) return true;
  if (message.isCheer && message.bits > 0) return true;
  return false;
}

function isRepeatOffender(deps: PriorityClassifierDeps, chatterId: string, nowMs: number): boolean {
  const afterTimestamp = new Date(nowMs - REPEAT_OFFENDER_WINDOW_MS).toISOString();
  return deps.countRecentTimeoutsForUser(chatterId, afterTimestamp) > 0;
}

export function createPriorityClassifier(deps: PriorityClassifierDeps): (item: AiReviewWorkItem) => Priority {
  return (item: AiReviewWorkItem): Priority => {
    if (item.aiMode.mode === "social") return "normal";

    if (isRepeatOffender(deps, item.message.chatterId, item.nowMs)) return "high";
    if (hasRiskSignals(item.message)) return "high";
    if (hasTrustSignals(item.message)) return "normal";

    return "high";
  };
}

/**
 * Coalesce key: group by chatter so rapid messages from the same user merge.
 * Returns undefined for social mode (no coalescing for social replies).
 */
export function workItemCoalesceKey(item: AiReviewWorkItem): string | undefined {
  if (item.aiMode.mode === "social") return undefined;
  return item.message.chatterId;
}

/**
 * Coalesce strategy: keep the riskier message (by signal score), fall back to latest.
 * Carries forward the cumulative count.
 */
export function coalesceWorkItems(
  existing: AiReviewWorkItem,
  incoming: AiReviewWorkItem,
  currentCount: number,
): CoalesceResult<AiReviewWorkItem> {
  const newCount = currentCount + 1;
  const existingRisk = messageRiskScore(existing.message);
  const incomingRisk = messageRiskScore(incoming.message);

  // Keep the riskier message; on tie, keep the incoming (latest) one.
  const winner = incomingRisk >= existingRisk ? incoming : existing;

  return {
    merged: { ...winner, nowMs: incoming.nowMs, coalescedCount: newCount },
    count: newCount,
  };
}

export function messageRiskScore(message: NormalizedChatMessage): number {
  let score = 0;
  if (detectUrls(message.text).detected) score += 4;
  if (isHighCaps(message.text)) score += 3;
  if (countMentions(message) >= MENTION_COUNT_THRESHOLD) score += 2;
  if (message.text.length > LENGTH_THRESHOLD) score += 1;
  return score;
}
