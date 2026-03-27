import type { ActionKind, ActionRequest, AiMode, ConfigSnapshot } from "../types.js";

export class CooldownManager {
  private lastBotMessageAt = 0;
  private readonly lastReplyByUser = new Map<string, number>();
  private lastModerationNoticeAt = 0;
  private readonly lastModerationNoticeByUser = new Map<string, number>();
  private readonly lastModerationByUser = new Map<string, number>();
  private readonly lastEquivalentAction = new Map<string, number>();
  private readonly lastAiModerationReviewByUser = new Map<string, number>();
  private readonly lastAiSocialReviewByUser = new Map<string, number>();
  private readonly evictionTtlMs: number;
  private lastPrunedAt = 0;

  public constructor(private readonly config: ConfigSnapshot["cooldowns"]) {
    // Eviction TTL is 2x the longest configured cooldown so entries are never pruned prematurely.
    this.evictionTtlMs =
      2 *
      Math.max(
        config.chat.minimumSecondsBetweenBotRepliesToSameUser,
        config.chat.minimumSecondsBetweenModerationNoticesPerUser,
        config.moderation.minimumSecondsBetweenModerationActionsPerUser,
        config.moderation.minimumSecondsBetweenEquivalentActions,
        config.ai.minimumSecondsBetweenAiModerationReviewsForSameUser,
        config.ai.minimumSecondsBetweenAiSocialReviewsForSameUser,
      ) *
      1000;
  }

  public canReviewWithAi(userId: string, mode: AiMode, now = Date.now()): boolean {
    const previous =
      mode === "social"
        ? (this.lastAiSocialReviewByUser.get(userId) ?? 0)
        : (this.lastAiModerationReviewByUser.get(userId) ?? 0);
    const minimumSeconds =
      mode === "social"
        ? this.config.ai.minimumSecondsBetweenAiSocialReviewsForSameUser
        : this.config.ai.minimumSecondsBetweenAiModerationReviewsForSameUser;

    return now - previous >= minimumSeconds * 1000;
  }

  public recordAiReview(userId: string, mode: AiMode, now = Date.now()): void {
    const targetMap = mode === "social" ? this.lastAiSocialReviewByUser : this.lastAiModerationReviewByUser;
    targetMap.set(userId, now);
    this.pruneIfDue(now);
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

  public canSendModerationNotice(userId?: string, now = Date.now()): { allowed: boolean; reason?: string } {
    const globalDelta = now - this.lastModerationNoticeAt;

    if (globalDelta < this.config.chat.minimumSecondsBetweenModerationNotices * 1000) {
      return { allowed: false, reason: "global moderation notice cooldown active" };
    }

    if (!userId) {
      return { allowed: true };
    }

    const userDelta = now - (this.lastModerationNoticeByUser.get(userId) ?? 0);

    if (userDelta < this.config.chat.minimumSecondsBetweenModerationNoticesPerUser * 1000) {
      return { allowed: false, reason: "per-user moderation notice cooldown active" };
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
    } else if (action.kind === "warn") {
      this.lastModerationNoticeAt = now;

      if (action.targetUserId) {
        this.lastModerationNoticeByUser.set(action.targetUserId, now);
      }
    } else if (action.kind === "timeout" && action.targetUserId) {
      this.lastModerationByUser.set(action.targetUserId, now);
      this.lastEquivalentAction.set(`${action.kind}:${action.targetUserId}`, now);
    }

    this.pruneIfDue(now);
  }

  private pruneIfDue(now: number): void {
    // Prune at most once per 30 seconds to avoid iterating all maps on every write.
    if (now - this.lastPrunedAt < 30_000) {
      return;
    }
    this.lastPrunedAt = now;

    this.pruneMap(this.lastReplyByUser, now);
    this.pruneMap(this.lastModerationNoticeByUser, now);
    this.pruneMap(this.lastModerationByUser, now);
    this.pruneMap(this.lastEquivalentAction, now);
    this.pruneMap(this.lastAiModerationReviewByUser, now);
    this.pruneMap(this.lastAiSocialReviewByUser, now);
  }

  private pruneMap(map: Map<string, number>, now: number): void {
    for (const [key, timestamp] of map.entries()) {
      if (now - timestamp > this.evictionTtlMs) {
        map.delete(key);
      }
    }
  }
}
