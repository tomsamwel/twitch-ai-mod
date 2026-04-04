import type { CoalesceResult, Priority } from "./ai-review-queue.js";
import type { AiReviewWorkItem } from "./message-processor.js";
import type { NormalizedChatMessage } from "../types.js";
import { hasRiskSignals, messageRiskScore } from "../moderation/risk-signals.js";

const REPEAT_OFFENDER_WINDOW_MS = 3_600_000;

export interface PriorityClassifierDeps {
  countRecentTimeoutsForUser(targetUserId: string, afterTimestamp: string): number;
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

    return "normal";
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

export { messageRiskScore } from "../moderation/risk-signals.js";
