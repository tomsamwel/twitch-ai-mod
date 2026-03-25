import crypto from "node:crypto";

import type { Logger } from "pino";

import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import type { BotDatabase } from "../storage/database.js";
import type { ActionRequest, ActionResult, ConfigSnapshot, ProcessingMode, ProposedAction } from "../types.js";
import type { TwurpleTwitchGateway } from "../twitch/twitch-gateway.js";

interface OutboundMessageRecorder {
  note(messageId: string): void;
}

export class ActionExecutor {
  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
    private readonly database: Pick<BotDatabase, "recordAction">,
    private readonly cooldowns: CooldownManager,
    private readonly twitchGateway: Pick<TwurpleTwitchGateway, "sendChatMessage" | "timeoutUser">,
    private readonly runtimeSettings: Pick<RuntimeSettingsStore, "getEffectiveSettings">,
    private readonly outboundMessages?: OutboundMessageRecorder,
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
    return {
      ...action,
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
        case "timeout":
          result = await this.executeTimeout(action);
          break;
      }
    } catch (error) {
      result = {
        id: action.id,
        kind: action.kind,
        status: "failed",
        dryRun: action.dryRun,
        reason: action.reason,
        error: error instanceof Error ? error.message : "unknown action execution error",
      };
    }

    if (result.status !== "failed") {
      const actionTimestamp = Date.parse(action.initiatedAt);
      this.cooldowns.recordAction(action, Number.isNaN(actionTimestamp) ? Date.now() : actionTimestamp);
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
      },
      "processed action request",
    );
    return result;
  }

  private async executeSay(action: ActionRequest): Promise<ActionResult> {
    if (!action.message) {
      throw new Error("say action is missing a message payload");
    }

    const actionTimestamp = Date.parse(action.initiatedAt);
    const now = Number.isNaN(actionTimestamp) ? Date.now() : actionTimestamp;
    const chatGate = this.cooldowns.canSendMessage(action.targetUserId, now);

    if (!chatGate.allowed) {
      return {
        id: action.id,
        kind: action.kind,
        status: "skipped",
        dryRun: action.dryRun,
        reason: chatGate.reason ?? "chat cooldown active",
      };
    }

    if (action.dryRun) {
      return {
        id: action.id,
        kind: action.kind,
        status: "dry-run",
        dryRun: true,
        reason: action.reason,
      };
    }

    if (!this.config.actions.allowLiveChatMessages) {
      return {
        id: action.id,
        kind: action.kind,
        status: "skipped",
        dryRun: false,
        reason: "live chat messages are disabled in config",
      };
    }

    const sentMessage = await this.twitchGateway.sendChatMessage(action.message, action.replyParentMessageId);
    this.outboundMessages?.note(sentMessage.id);

    return {
      id: action.id,
      kind: action.kind,
      status: "executed",
      dryRun: false,
      reason: action.reason,
      externalMessageId: sentMessage.id,
    };
  }

  private async executeTimeout(action: ActionRequest): Promise<ActionResult> {
    if (!action.targetUserId) {
      throw new Error("timeout action is missing a targetUserId");
    }

    if (!action.durationSeconds || action.durationSeconds <= 0) {
      throw new Error("timeout action is missing a valid durationSeconds");
    }

    const actionTimestamp = Date.parse(action.initiatedAt);
    const now = Number.isNaN(actionTimestamp) ? Date.now() : actionTimestamp;
    const moderationGate = this.cooldowns.canModerateUser(action.targetUserId, action.kind, now);

    if (!moderationGate.allowed) {
      return {
        id: action.id,
        kind: action.kind,
        status: "skipped",
        dryRun: action.dryRun,
        reason: moderationGate.reason ?? "moderation cooldown active",
      };
    }

    if (action.dryRun) {
      return {
        id: action.id,
        kind: action.kind,
        status: "dry-run",
        dryRun: true,
        reason: action.reason,
      };
    }

    const runtimeSettings = this.runtimeSettings.getEffectiveSettings();

    if (!runtimeSettings.liveModerationEnabled) {
      return {
        id: action.id,
        kind: action.kind,
        status: "skipped",
        dryRun: false,
        reason: "live moderation actions are disabled in config",
      };
    }

    if (action.source === "ai" && !runtimeSettings.aiModerationEnabled) {
      return {
        id: action.id,
        kind: action.kind,
        status: "skipped",
        dryRun: false,
        reason: "AI live moderation actions are disabled by runtime control",
      };
    }

    await this.twitchGateway.timeoutUser(action.targetUserId, action.durationSeconds, action.reason);

    return {
      id: action.id,
      kind: action.kind,
      status: "executed",
      dryRun: false,
      reason: action.reason,
    };
  }
}
