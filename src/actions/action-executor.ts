import crypto from "node:crypto";

import type { Logger } from "pino";

import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import type { BotDatabase } from "../storage/database.js";
import type { ActionRequest, ActionResult, ConfigSnapshot, ProcessingMode, ProposedAction } from "../types.js";
import type { SentChatMessage, TwurpleTwitchGateway } from "../twitch/twitch-gateway.js";
import { asRecord } from "../utils.js";

interface OutboundMessageRecorder {
  note(messageId: string): void;
}

function resolveActionTimestamp(action: ActionRequest): number {
  const parsed = Date.parse(action.initiatedAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function buildResult(
  action: ActionRequest,
  status: ActionResult["status"],
  extra?: { reason?: string; externalMessageId?: string; error?: string },
): ActionResult {
  return {
    id: action.id,
    kind: action.kind,
    status,
    dryRun: status === "dry-run" ? true : action.dryRun,
    reason: extra?.reason ?? action.reason,
    ...(extra?.externalMessageId ? { externalMessageId: extra.externalMessageId } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
  };
}

export class ActionExecutor {
  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
    private readonly database: Pick<BotDatabase, "recordAction" | "countRecentTimeoutsForUser">,
    private readonly cooldowns: CooldownManager,
    private readonly twitchGateway: Pick<TwurpleTwitchGateway, "sendChatMessage" | "timeoutUser">,
    private readonly runtimeSettings: Pick<RuntimeSettingsStore, "getEffectiveSettings">,
    private readonly outboundMessages?: OutboundMessageRecorder,
    private readonly isUserExempt?: (login: string) => boolean,
  ) {}

  public createActionRequest(
    action: ProposedAction,
    input: {
      source: "rules" | "ai";
      sourceEventId: string;
      sourceMessageId: string;
      processingMode?: ProcessingMode;
      runId?: string;
      dryRun?: boolean;
      initiatedAt?: string;
    },
  ): ActionRequest {
    const replyParentMessageId =
      action.replyParentMessageId ?? (action.kind === "warn" ? input.sourceMessageId : undefined);

    return {
      ...action,
      ...(replyParentMessageId ? { replyParentMessageId } : {}),
      id: crypto.randomUUID(),
      source: input.source,
      sourceEventId: input.sourceEventId,
      sourceMessageId: input.sourceMessageId,
      processingMode: input.processingMode ?? "live",
      ...(input.runId ? { runId: input.runId } : {}),
      dryRun: input.dryRun ?? this.runtimeSettings.getEffectiveSettings().dryRun,
      initiatedAt: input.initiatedAt ?? new Date().toISOString(),
    };
  }

  public async execute(action: ActionRequest): Promise<ActionResult> {
    let result: ActionResult;

    try {
      switch (action.kind) {
        case "say":
          result = await this.executeSay(action);
          break;
        case "warn":
          result = await this.executeWarn(action);
          break;
        case "timeout":
          result = await this.executeTimeout(action);
          break;
        default: {
          const _exhaustive: never = action.kind;
          throw new Error(`Unexpected action kind: ${String(_exhaustive)}`);
        }
      }
    } catch (error) {
      result = buildResult(action, "failed", {
        error: error instanceof Error ? error.message : "unknown action execution error",
      });
    }

    if (result.status === "executed" || result.status === "dry-run") {
      this.cooldowns.recordAction(action, resolveActionTimestamp(action));
    }

    this.database.recordAction(action, result);
    this.logger.info(
      {
        actionId: action.id,
        kind: action.kind,
        status: result.status,
        dryRun: result.dryRun,
        processingMode: action.processingMode,
        targetUserId: action.targetUserId,
        ...(result.status === "skipped" && result.reason ? { skipReason: result.reason } : {}),
      },
      "processed action request",
    );
    return result;
  }

  private async executeSay(action: ActionRequest): Promise<ActionResult> {
    if (!action.message) {
      throw new Error("say action is missing a message payload");
    }

    const now = resolveActionTimestamp(action);
    const chatGate = this.cooldowns.canSendMessage(action.targetUserId, now);

    if (!chatGate.allowed) {
      return buildResult(action, "skipped", { reason: chatGate.reason ?? "chat cooldown active" });
    }

    if (action.dryRun) {
      return buildResult(action, "dry-run");
    }

    if (!this.config.actions.allowLiveChatMessages) {
      return buildResult(action, "skipped", { reason: "live chat messages are disabled in config" });
    }

    const sentMessage = await this.sendWithReplyFallback(action);
    this.outboundMessages?.note(sentMessage.id);

    return buildResult(action, "executed", { externalMessageId: sentMessage.id });
  }

  private async executeWarn(action: ActionRequest): Promise<ActionResult> {
    if (!action.message) {
      throw new Error("warn action is missing a message payload");
    }

    const metadata = asRecord(action.metadata);
    const timeoutCompanion = metadata?.timeoutCompanion === true;
    const companionTimeoutStatus =
      metadata?.companionTimeoutStatus &&
      typeof metadata.companionTimeoutStatus === "string"
        ? metadata.companionTimeoutStatus
        : null;

    if (
      timeoutCompanion &&
      companionTimeoutStatus &&
      companionTimeoutStatus !== "executed" &&
      companionTimeoutStatus !== "dry-run"
    ) {
      return buildResult(action, "skipped", {
        reason: "timeout notice skipped because the preceding timeout did not execute",
      });
    }

    const now = resolveActionTimestamp(action);
    const chatGate = this.cooldowns.canSendModerationNotice(action.targetUserId, now);

    if (!chatGate.allowed) {
      return buildResult(action, "skipped", { reason: chatGate.reason ?? "moderation notice cooldown active" });
    }

    if (action.dryRun) {
      return buildResult(action, "dry-run");
    }

    if (!this.config.actions.allowLiveChatMessages) {
      return buildResult(action, "skipped", { reason: "live chat messages are disabled in config" });
    }

    const sentMessage = await this.sendWithReplyFallback(action);
    this.outboundMessages?.note(sentMessage.id);

    return buildResult(action, "executed", { externalMessageId: sentMessage.id });
  }

  private async executeTimeout(action: ActionRequest): Promise<ActionResult> {
    if (!action.targetUserId) {
      throw new Error("timeout action is missing a targetUserId");
    }

    if (!action.durationSeconds || action.durationSeconds <= 0) {
      throw new Error("timeout action is missing a valid durationSeconds");
    }

    if (this.isUserExempt?.(action.targetUserName ?? "")) {
      return buildResult(action, "skipped", { reason: "target user is exempt from moderation" });
    }

    const now = resolveActionTimestamp(action);
    const moderationGate = this.cooldowns.canModerateUser(action.targetUserId, action.kind, now);

    if (!moderationGate.allowed) {
      return buildResult(action, "skipped", { reason: moderationGate.reason ?? "moderation cooldown active" });
    }

    if (action.dryRun) {
      return buildResult(action, "dry-run");
    }

    const runtimeSettings = this.runtimeSettings.getEffectiveSettings();

    if (!runtimeSettings.liveModerationEnabled) {
      return buildResult(action, "skipped", { reason: "live moderation actions are disabled in config" });
    }

    if (action.source === "ai" && !runtimeSettings.aiModerationEnabled) {
      return buildResult(action, "skipped", { reason: "AI live moderation actions are disabled by runtime control" });
    }

    if (action.source === "ai") {
      const precisionGateFailure = this.getAiTimeoutPrecisionGateFailure(action);

      if (precisionGateFailure) {
        return buildResult(action, "skipped", { reason: "AI timeout blocked by precision gate" });
      }
    }

    const effectiveDuration = this.resolveProgressiveDuration(action);
    await this.twitchGateway.timeoutUser(action.targetUserId, effectiveDuration, action.reason);

    return buildResult(action, "executed");
  }

  private resolveProgressiveDuration(action: ActionRequest): number {
    const progressive = this.config.moderationPolicy.deterministicRules.progressiveTimeouts;
    if (!progressive?.enabled || !action.targetUserId) {
      return action.durationSeconds!;
    }

    const windowStart = new Date(Date.now() - progressive.windowSeconds * 1000).toISOString();
    const priorCount = this.database.countRecentTimeoutsForUser(action.targetUserId, windowStart);

    // Find the highest tier where maxPriorTimeouts <= priorCount.
    const sorted = [...progressive.tiers].sort((a, b) => b.maxPriorTimeouts - a.maxPriorTimeouts);
    const tier = sorted.find((t) => priorCount >= t.maxPriorTimeouts);
    const resolvedDuration = tier?.durationSeconds ?? action.durationSeconds!;

    if (resolvedDuration !== action.durationSeconds) {
      this.logger.info(
        { targetUserId: action.targetUserId, priorCount, resolvedDuration, originalDuration: action.durationSeconds },
        "progressive timeout duration resolved",
      );
    }

    return resolvedDuration;
  }

  private getAiTimeoutPrecisionGateFailure(action: ActionRequest): string | null {
    const candidate = asRecord(action.metadata);

    if (!candidate) {
      return "missing ai timeout precision metadata";
    }
    const confidence = typeof candidate.aiConfidence === "number" ? candidate.aiConfidence : null;
    const moderationCategory =
      typeof candidate.moderationCategory === "string" ? candidate.moderationCategory : null;
    const targetIsPrivileged = candidate.targetIsPrivileged === true;
    const targetIsSelfAuthored = candidate.targetIsSelfAuthored === true;
    const hasRepeatedUserEvidence = candidate.hasRepeatedUserEvidence === true;
    const hasRecentBotCorrectiveInteraction = candidate.hasRecentBotCorrectiveInteraction === true;
    const liveTimeouts = this.config.moderationPolicy.aiPolicy.liveTimeouts;

    if (confidence === null || confidence < liveTimeouts.minimumConfidence) {
      return "ai confidence below live timeout minimum";
    }

    if (!moderationCategory || !liveTimeouts.allowedCategories.includes(moderationCategory as never)) {
      return "moderation category is not allowlisted for live timeout";
    }

    if (targetIsPrivileged || targetIsSelfAuthored) {
      return "target is privileged or self-authored";
    }

    if (
      moderationCategory === "spam-escalation" &&
      !hasRepeatedUserEvidence &&
      !hasRecentBotCorrectiveInteraction
    ) {
      return "spam escalation lacks repeat evidence or a prior corrective interaction";
    }

    return null;
  }

  /**
   * Send a chat message, falling back to a non-reply if the reply-parent message
   * was purged (e.g. by a preceding timeout).
   */
  private async sendWithReplyFallback(action: ActionRequest): Promise<SentChatMessage> {
    try {
      return await this.twitchGateway.sendChatMessage(action.message!, action.replyParentMessageId);
    } catch (error) {
      if (action.replyParentMessageId && error instanceof Error && error.message.includes("cannot be replied to")) {
        this.logger.warn({ actionId: action.id }, "reply-parent no longer valid, retrying without reply");
        return await this.twitchGateway.sendChatMessage(action.message!);
      }
      throw error;
    }
  }
}
