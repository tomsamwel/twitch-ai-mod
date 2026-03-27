import type { Logger } from "pino";

import { AiContextBuilder } from "../ai/context-builder.js";
import { AiProviderRegistry } from "../ai/provider-registry.js";
import { buildAiDecisionInput, selectAiMode } from "../ai/prompt.js";
import type { AiModeSelection } from "../ai/prompt.js";
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

export interface AiReviewWorkItem {
  message: NormalizedChatMessage;
  botIdentity: TwitchIdentity;
  processingMode: ProcessingMode;
  runId?: string;
  forceDryRun?: boolean;
  nowMs: number;
  aiMode: AiModeSelection;
}

interface OutboundMessageTrackerLike {
  consume(messageId: string, now?: number): boolean;
}

/** Minimal interface so MessageProcessor doesn't depend on the concrete queue class. */
interface AiReviewDispatcher {
  enqueue(data: AiReviewWorkItem): void;
}

function annotateAiActionForExecution(
  action: AiDecision["actions"][number],
  decision: AiDecision,
  message: NormalizedChatMessage,
  context: ReturnType<AiContextBuilder["build"]>,
  botIdentity: TwitchIdentity,
): AiDecision["actions"][number] {
  if (action.kind !== "timeout") {
    return action;
  }

  return {
    ...action,
    metadata: {
      ...(action.metadata ?? {}),
      aiConfidence: decision.confidence,
      moderationCategory: decision.moderationCategory,
      targetIsPrivileged: message.isPrivileged,
      targetIsSelfAuthored: message.chatterId === botIdentity.id,
      hasRepeatedUserEvidence: context.recentUserMessages.length > 0,
      hasRecentBotCorrectiveInteraction: context.recentBotInteractions.some(
        (interaction) =>
          (interaction.kind === "say" || interaction.kind === "warn") && interaction.status !== "failed",
      ),
    },
  };
}

function annotateWarnCompanionForExecution(
  action: RuleDecision["actions"][number] | AiDecision["actions"][number],
  previousTimeoutStatus: ActionResult["status"] | null,
): RuleDecision["actions"][number] | AiDecision["actions"][number] {
  if (action.kind !== "warn" || !previousTimeoutStatus) {
    return action;
  }

  return {
    ...action,
    metadata: {
      ...(action.metadata ?? {}),
      timeoutCompanion: true,
      companionTimeoutStatus: previousTimeoutStatus,
    },
  };
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
    private readonly aiReviewQueue?: AiReviewDispatcher,
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
      await this.executeActions(ruleDecision.actions, actionResults, {
        source: "rules",
        message,
        processingMode,
        runId: options.runId,
        forceDryRun: options.forceDryRun,
        nowMs,
      });

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

    if (!this.cooldowns.canReviewWithAi(message.chatterId, aiMode.mode, nowMs)) {
      this.logger.debug(
        { chatterId: message.chatterId, eventId: message.eventId, processingMode, mode: aiMode.mode },
        "skipping AI review due to cooldown",
      );

      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults,
      };
    }

    this.cooldowns.recordAiReview(message.chatterId, aiMode.mode, nowMs);

    const workItem: AiReviewWorkItem = {
      message,
      botIdentity: options.botIdentity,
      processingMode,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.forceDryRun ? { forceDryRun: options.forceDryRun } : {}),
      nowMs,
      aiMode,
    };

    if (this.aiReviewQueue && processingMode === "live") {
      this.aiReviewQueue.enqueue(workItem);
      return {
        status: "processed",
        ruleDecision,
        aiDecision: null,
        actionResults: [],
      };
    }

    // Direct path: eval, replay, or live without queue.
    const aiResult = await this.processAiReview(workItem);

    return {
      status: "processed",
      ruleDecision,
      aiDecision: aiResult.aiDecision,
      actionResults: aiResult.actionResults,
    };
  }

  /**
   * Execute the AI review phase for a single message.
   * Called directly in eval/replay mode, or via the queue handler in live mode.
   */
  public async processAiReview(
    work: AiReviewWorkItem,
  ): Promise<{ aiDecision: AiDecision; actionResults: ActionResult[] }> {
    const effectiveSettings = this.runtimeSettings.getEffectiveSettings();
    const effectiveConfig = this.aiProviders.createEffectiveConfig(effectiveSettings);
    const persistenceContext = {
      processingMode: work.processingMode,
      ...(work.runId ? { runId: work.runId } : {}),
    };

    const context = this.contextBuilder.build(work.message, work.botIdentity);
    const aiInput = buildAiDecisionInput(work.message, context, effectiveConfig, work.botIdentity, work.aiMode);
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
        eventId: work.message.eventId,
        processingMode: work.processingMode,
        outcome: aiDecision.outcome,
        mode: aiDecision.mode,
        reason: aiDecision.reason,
        actionCount: aiDecision.actions.length,
      },
      "processed AI decision",
    );
    this.database.recordAiDecision(work.message, aiDecision, persistenceContext);

    const actionResults: ActionResult[] = [];

    if (aiDecision.actions.length > 0) {
      const annotatedActions = aiDecision.actions.map((action) =>
        annotateAiActionForExecution(action, aiDecision, work.message, context, work.botIdentity),
      );

      await this.executeActions(annotatedActions, actionResults, {
        source: "ai",
        message: work.message,
        processingMode: work.processingMode,
        runId: work.runId,
        forceDryRun: work.forceDryRun,
        nowMs: work.nowMs,
      });
    }

    return { aiDecision, actionResults };
  }

  private async executeActions(
    actions: Array<RuleDecision["actions"][number] | AiDecision["actions"][number]>,
    results: ActionResult[],
    context: {
      source: "rules" | "ai";
      message: NormalizedChatMessage;
      processingMode: ProcessingMode;
      runId?: string | undefined;
      forceDryRun?: boolean | undefined;
      nowMs: number;
    },
  ): Promise<void> {
    let previousTimeoutStatus: ActionResult["status"] | null = null;

    for (const action of actions) {
      const actionRequest = this.actionExecutor.createActionRequest(
        annotateWarnCompanionForExecution(action, previousTimeoutStatus),
        {
          source: context.source,
          sourceEventId: context.message.eventId,
          sourceMessageId: context.message.sourceMessageId,
          processingMode: context.processingMode,
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.forceDryRun ? { dryRun: true } : {}),
          initiatedAt: new Date(context.nowMs).toISOString(),
        },
      );

      const actionResult = await this.actionExecutor.execute(actionRequest);
      results.push(actionResult);

      if (action.kind === "timeout") {
        previousTimeoutStatus = actionResult.status;
      }
    }
  }

  private resolveNowMs(message: NormalizedChatMessage, nowMs: number | undefined): number {
    if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
      return nowMs;
    }

    const parsed = Date.parse(message.receivedAt);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}
