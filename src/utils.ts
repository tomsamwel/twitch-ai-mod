import type { NormalizedChatMessage } from "./types.js";

/** Type-narrow an unknown value to a plain object, or return null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Count @-mention parts in a chat message. */
export function countMentions(message: NormalizedChatMessage): number {
  return message.parts.filter((part) => part.type === "mention").length;
}
