import type { Logger } from "pino";

import { AiContextBuilder } from "../ai/context-builder.js";
import { AiProviderRegistry } from "../ai/provider-registry.js";
import { buildAiDecisionInput, selectAiMode } from "../ai/prompt.js";
import type { ActionExecutor } from "../actions/action-executor.js";
import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import { RuleEngine } from "../moderation/rule-engine.js";
import type { BotDatabase } from "../storage/database.js";
import type {
  ActionResult,
  AiDecision,
  ConfigSnapshot,
  NormalizedChatMessage,
  ProcessingMode,
  RuleDecision,
  TwitchIdentity,
} from "../types.js";

interface MessageProcessorOptions {
  botIdentity: TwitchIdentity;
  processingMode?: ProcessingMode;
  runId?: string;
  dedupe?: boolean;
  persistSnapshot?: boolean;
  forceDryRun?: boolean;
  nowMs?: number;
}

export interface MessageProcessingResult {
  status: "processed" | "duplicate" | "ignored";
  ruleDecision: RuleDecision | null;
  aiDecision: AiDecision | null;
  actionResults: ActionResult[];
}

interface OutboundMessageTrackerLike {
  consume(messageId: string, now?: number): boolean;
}

export class MessageProcessor {
  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
    private readonly database: Pick<
      BotDatabase,
      | "registerIngestedEvent"
      | "recordMessageSnapshot"
      | "recordRuleDecision"
      | "recordAiDecision"
    >,
    private readonly cooldowns: CooldownManager,
    private readonly ruleEngine: RuleEngine,
    private readonly contextBuilder: AiContextBuilder,
    private readonly runtimeSettings: Pick<RuntimeSettingsStore, "getEffectiveSettings">,
    private readonly aiProviders: Pick<AiProviderRegistry, "createEffectiveConfig" | "getProvider">,
    private readonly actionExecutor: Pick<ActionExecutor, "createActionRequest" | "execute">,
    private readonly outboundMessageTracker?: OutboundMessageTrackerLike,
  ) {}

  public async process(
    message: NormalizedChatMessage,
    options: MessageProcessorOptions,
  ): Promise<MessageProcessingResult> {
    const processingMode = options.processingMode ?? "live";
    const nowMs = this.resolveNowMs(message, options.nowMs);
    const persistenceContext = {
      processingMode,
      ...(options.runId ? { runId: options.runId } : {}),
    };

    if (options.dedupe ?? false) {
      if (!this.database.registerIngestedEvent(message.eventId, message.sourceMessageId)) {
        this.logger.debug({ eventId: message.eventId, processingMode }, "skipping duplicate chat message");
        return {
          status: "duplicate",
          ruleDecision: null,
          aiDecision: null,
          actionResults: [],
        };
      }
    }

    if (options.persistSnapshot ?? false) {
      this.database.recordMessageSnapshot(message, options.botIdentity);
    }

    if (message.chatterId === options.botIdentity.id) {
      this.logger.debug(
        {
          eventId: message.eventId,
          sourceMessageId: message.sourceMessageId,
          chatter: message.chatterLogin,
          processingMode,
        },
        "ignoring bot-authored chat message after snapshotting",
      );

      return {
        status: "ignored",
        ruleDecision: null,
        aiDecision: null,
        actionResults: [],
      };
    }

    if (this.outboundMessageTracker?.consume(message.sourceMessageId, nowMs)) {
      this.logger.debug(
        {
          eventId: message.eventId,
          sourceMessageId: message.sourceMessageId,
          chatter: message.chatterLogin,
          processingMode,
        },
        "ignoring bot-authored outbound chat message",
      );

      return {
        status: "ignored",
        ruleDecision: null,
        aiDecision: null,
        actionResults: [],
      };
    }

    this.logger.info(
      {
        eventId: message.eventId,
        chatter: message.chatterLogin,
        text: message.text,
        processingMode,
      },
      "received chat message",
    );

    const ruleDecision = this.ruleEngine.evaluate(message, nowMs);
    this.database.recordRuleDecision(message, ruleDecision, persistenceContext);

    const actionResults: ActionResult[] = [];

    if (ruleDecision.actions.length > 0) {
      for (const action of ruleDecision.actions) {
        const actionRequest = this.actionExecutor.createActionRequest(action, {
          source: "rules",
          sourceEventId: message.eventId,
          sourceMessageId: message.sourceMessageId,
          processingMode,
          ...(options.runId ? { runId: options.runId } : {}),
          ...(options.forceDryRun ? { dryRun: true } : {}),
          initiatedAt: new Date(nowMs).toISOString(),
        });

        actionResults.push(await this.actionExecutor.execute(actionRequest));
      }

      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    const effectiveSettings = this.runtimeSettings.getEffectiveSettings();

    if (!effectiveSettings.aiEnabled || !this.config.moderationPolicy.aiPolicy.enabled) {
      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    const effectiveConfig = this.aiProviders.createEffectiveConfig(effectiveSettings);
    const aiMode = selectAiMode(message, options.botIdentity, effectiveConfig);

    if (aiMode.mode === "social" && !effectiveSettings.socialRepliesEnabled) {
      this.logger.debug(
        { chatterId: message.chatterId, eventId: message.eventId, processingMode },
        "skipping social AI review because social replies are disabled",
      );

      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    if (message.isPrivileged && aiMode.mode !== "social") {
      this.logger.debug(
        { chatterId: message.chatterId, eventId: message.eventId, processingMode, mode: aiMode.mode },
        "skipping AI review for privileged chatter in moderation mode",
      );

      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    if (!this.cooldowns.canReviewWithAi(message.chatterId, nowMs)) {
      this.logger.debug(
        { chatterId: message.chatterId, eventId: message.eventId, processingMode },
        "skipping AI review due to cooldown",
      );

      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    this.cooldowns.recordAiReview(message.chatterId, nowMs);

    const context = this.contextBuilder.build(message, options.botIdentity);
    const aiInput = buildAiDecisionInput(message, context, effectiveConfig, options.botIdentity, aiMode);
    const aiProvider = await this.aiProviders.getProvider(effectiveConfig);
    let aiDecision = await aiProvider.decide(aiInput);

    if (!effectiveSettings.socialRepliesEnabled) {
      const filteredActions = aiDecision.actions.filter((action) => action.kind !== "say");
      if (filteredActions.length !== aiDecision.actions.length) {
        aiDecision = {
          ...aiDecision,
          outcome: filteredActions.length > 0 ? "action" : "abstain",
          reason:
            filteredActions.length > 0
              ? aiDecision.reason
              : "social replies are disabled by runtime control",
          actions: filteredActions,
        };
      }
    }

    this.logger.info(
      {
        eventId: message.eventId,
        processingMode,
        outcome: aiDecision.outcome,
        mode: aiDecision.mode,
        reason: aiDecision.reason,
        actionCount: aiDecision.actions.length,
      },
      "processed AI decision",
    );
    this.database.recordAiDecision(message, aiDecision, persistenceContext);

    if (aiDecision.actions.length === 0) {
      return {
        status: "processed",
        ruleDecision,
        aiDecision,
        actionResults,
      };
    }

    for (const action of aiDecision.actions) {
      const actionRequest = this.actionExecutor.createActionRequest(action, {
        source: "ai",
        sourceEventId: message.eventId,
        sourceMessageId: message.sourceMessageId,
        processingMode,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.forceDryRun ? { dryRun: true } : {}),
        initiatedAt: new Date(nowMs).toISOString(),
      });

      actionResults.push(await this.actionExecutor.execute(actionRequest));
    }

    return {
      status: "processed",
      ruleDecision,
      aiDecision,
      actionResults,
    };
  }

  private resolveNowMs(message: NormalizedChatMessage, nowMs: number | undefined): number {
    if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
      return nowMs;
    }

    const parsed = Date.parse(message.receivedAt);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}
