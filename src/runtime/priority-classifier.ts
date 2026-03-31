import type { Priority } from "./ai-review-queue.js";
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

function hasRiskSignals(message: NormalizedChatMessage): boolean {
  if (detectUrls(message.text).detected) return true;

  let upper = 0;
  let alpha = 0;
  for (const ch of message.text) {
    if (ch >= "A" && ch <= "Z") { upper++; alpha++; }
    else if (ch >= "a" && ch <= "z") { alpha++; }
  }
  if (alpha >= CAPS_MIN_ALPHA && upper / alpha > CAPS_RATIO_THRESHOLD) return true;

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
