import type { ActionKind, ActionRequest, ConfigSnapshot } from "../types.js";

export class CooldownManager {
  private lastBotMessageAt = 0;
  private readonly lastReplyByUser = new Map<string, number>();
  private readonly lastModerationByUser = new Map<string, number>();
  private readonly lastEquivalentAction = new Map<string, number>();
  private readonly lastAiReviewByUser = new Map<string, number>();

  public constructor(private readonly config: ConfigSnapshot["cooldowns"]) {}

  public canReviewWithAi(userId: string, now = Date.now()): boolean {
    const previous = this.lastAiReviewByUser.get(userId) ?? 0;
    return now - previous >= this.config.ai.minimumSecondsBetweenAiReviewsForSameUser * 1000;
  }

  public recordAiReview(userId: string, now = Date.now()): void {
    this.lastAiReviewByUser.set(userId, now);
  }

  public canSendMessage(userId?: string, now = Date.now()): { allowed: boolean; reason?: string } {
    const globalDelta = now - this.lastBotMessageAt;

    if (globalDelta < this.config.chat.minimumSecondsBetweenBotMessages * 1000) {
      return { allowed: false, reason: "global message cooldown active" };
    }

    if (!userId) {
      return { allowed: true };
    }

    const userDelta = now - (this.lastReplyByUser.get(userId) ?? 0);

    if (userDelta < this.config.chat.minimumSecondsBetweenBotRepliesToSameUser * 1000) {
      return { allowed: false, reason: "per-user message cooldown active" };
    }

    return { allowed: true };
  }

  public canModerateUser(
    userId: string,
    actionKind: ActionKind,
    now = Date.now(),
  ): { allowed: boolean; reason?: string } {
    const perUserDelta = now - (this.lastModerationByUser.get(userId) ?? 0);

    if (perUserDelta < this.config.moderation.minimumSecondsBetweenModerationActionsPerUser * 1000) {
      return { allowed: false, reason: "per-user moderation cooldown active" };
    }

    const actionKey = `${actionKind}:${userId}`;
    const actionDelta = now - (this.lastEquivalentAction.get(actionKey) ?? 0);

    if (actionDelta < this.config.moderation.minimumSecondsBetweenEquivalentActions * 1000) {
      return { allowed: false, reason: "equivalent moderation cooldown active" };
    }

    return { allowed: true };
  }

  public recordAction(action: Pick<ActionRequest, "kind" | "targetUserId">, now = Date.now()): void {
    if (action.kind === "say") {
      this.lastBotMessageAt = now;

      if (action.targetUserId) {
        this.lastReplyByUser.set(action.targetUserId, now);
      }

      return;
    }

    if (action.kind === "timeout" && action.targetUserId) {
      this.lastModerationByUser.set(action.targetUserId, now);
      this.lastEquivalentAction.set(`${action.kind}:${action.targetUserId}`, now);
    }
  }
}
