import type { Logger } from "pino";

import { AiContextBuilder } from "../ai/context-builder.js";
import { applyAiDecisionGuardrails } from "../ai/decision-guardrails.js";
import { AiProviderRegistry } from "../ai/provider-registry.js";
import { buildAiDecisionInput, selectAiMode } from "../ai/prompt.js";
import type { AiModeSelection } from "../ai/prompt.js";
import type { ActionExecutor } from "../actions/action-executor.js";
import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import { RuleEngine } from "../moderation/rule-engine.js";
import type { SessionChatterTracker } from "./session-chatter-tracker.js";
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
  coalescedCount: number;
  /** If set, any say action from this item will be sent as a reply to this message ID. */
  greetingReplyToMessageId?: string;
  /** True for poll-path greetings (silent joiners). Used by priority classifier for low-priority queueing. */
  isPollGreeting?: boolean;
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
          (interaction.kind === "warn" || interaction.kind === "timeout") && interaction.status !== "failed",
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
    private readonly sessionChatterTracker?: SessionChatterTracker,
    private readonly getQueueDepth?: () => number,
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
      this.database.recordMessageSnapshot(message, options.botIdentity, {
        processingMode,
      });
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
    let aiMode = selectAiMode(message, options.botIdentity, effectiveConfig);

    // First-time chatter detection: always tag isFirstTimeChatter on the first
    // message this session so the AI gets the scam escalation contract exception.
    // The AI decides whether to greet (clean message) or moderate (violation).
    // Only runs in live mode to avoid disrupting eval/replay scenarios.
    if (processingMode === "live" && this.sessionChatterTracker) {
      const isNew = this.sessionChatterTracker.isFirstMessage(message.chatterId);
      if (isNew) {
        aiMode = {
          mode: aiMode.mode,
          signals: { ...aiMode.signals, isFirstTimeChatter: true },
        };
        // Mark greeted immediately so the poll path doesn't also greet.
        this.sessionChatterTracker.markGreeted(message.chatterId, nowMs);
        this.logger.info(
          { chatterId: message.chatterId, chatter: message.chatterLogin, mode: aiMode.mode },
          "first-time chatter this session — tagged for moderation + greeting",
        );
      }
    }

    // Fast path: skip AI for messages that are clearly safe — no risk signals,
    // not addressing the bot, and no hard-violation keywords. The deterministic
    // rule engine already ran above, so blocked terms/spam/visual spam are handled.
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

    // In live mode with a queue, skip the per-user cooldown — the queue's
    // coalescing handles rapid-fire messages. Cooldown only gates the direct
    // path (eval/replay) where there's no queue.
    if (!this.aiReviewQueue || processingMode !== "live") {
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
    }

    const workItem: AiReviewWorkItem = {
      message,
      botIdentity: options.botIdentity,
      processingMode,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.forceDryRun ? { forceDryRun: options.forceDryRun } : {}),
      nowMs,
      aiMode,
      coalescedCount: 1,
      ...(aiMode.signals.isFirstTimeChatter ? { greetingReplyToMessageId: message.sourceMessageId } : {}),
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

    const context = this.contextBuilder.build(work.message, work.botIdentity, work.processingMode);
    const aiInput = buildAiDecisionInput(
      work.message, context, effectiveConfig, work.botIdentity, work.aiMode,
      work.coalescedCount > 1 ? work.coalescedCount : undefined,
      work.nowMs,
    );
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

    aiDecision = applyAiDecisionGuardrails(aiDecision, work.message, context, this.config);

    this.logger.info(
      {
        eventId: work.message.eventId,
        processingMode: work.processingMode,
        outcome: aiDecision.outcome,
        mode: aiDecision.mode,
        reason: aiDecision.reason,
        actionCount: aiDecision.actions.length,
        ...(work.coalescedCount > 1 ? { coalescedCount: work.coalescedCount } : {}),
      },
      "processed AI decision",
    );
    this.database.recordAiDecision(work.message, aiDecision, persistenceContext, aiInput.prompt);

    const actionResults: ActionResult[] = [];

    if (aiDecision.actions.length > 0) {
      const annotatedActions = aiDecision.actions.map((action) => {
        let annotated = annotateAiActionForExecution(action, aiDecision, work.message, context, work.botIdentity);
        // For first-time greetings, override the reply parent: thread to the
        // chatter's real message if available, or clear it for poll greetings
        // (where there is no real message to reply to).
        if (annotated.kind === "say" && work.aiMode.signals.isFirstTimeChatter) {
          const { replyParentMessageId: _dropped, ...rest } = annotated;
          annotated = work.greetingReplyToMessageId
            ? { ...rest, replyParentMessageId: work.greetingReplyToMessageId }
            : rest;
        }
        return annotated;
      });

      await this.executeActions(annotatedActions, actionResults, {
        source: "ai",
        message: work.message,
        processingMode: work.processingMode,
        runId: work.runId,
        forceDryRun: work.forceDryRun,
        nowMs: work.nowMs,
      });
    }

    // Mark greeted after executing actions so the rate limit and de-dupe are
    // only consumed when the work actually ran (not just on enqueue).
    if (work.aiMode.signals.isFirstTimeChatter) {
      this.sessionChatterTracker?.markGreeted(work.message.chatterId, work.nowMs);
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

  /**
   * Enqueue an AI-generated greeting for one or more viewers detected via the
   * chatters poll. Builds a single synthetic message listing all viewer names
   * so the AI produces one combined welcome.
   */
  public enqueuePollGreeting(
    viewers: Array<{ id: string; login: string; displayName: string }>,
    botIdentity: TwitchIdentity,
    broadcasterIdentity: TwitchIdentity,
  ): void {
    if (!this.aiReviewQueue || viewers.length === 0) return;

    const nowMs = Date.now();
    const primary = viewers[0]!;
    const greetingNames = viewers.map((v) => `@${v.displayName}`);

    const syntheticMessage: NormalizedChatMessage = {
      eventId: `poll-greet-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
      sourceMessageId: `poll-greet-${nowMs}`,
      receivedAt: new Date(nowMs).toISOString(),
      broadcasterId: broadcasterIdentity.id,
      broadcasterLogin: broadcasterIdentity.login,
      broadcasterDisplayName: broadcasterIdentity.displayName,
      chatterId: primary.id,
      chatterLogin: primary.login,
      chatterDisplayName: primary.displayName,
      text: "",
      normalizedText: "",
      urlResult: { detected: false, urls: [] },
      color: null,
      messageType: "text",
      badges: {},
      roles: [],
      isPrivileged: false,
      isReply: false,
      replyParentMessageId: null,
      replyParentUserId: null,
      replyParentUserLogin: null,
      replyParentUserDisplayName: null,
      threadMessageId: null,
      threadMessageUserId: null,
      threadMessageUserLogin: null,
      threadMessageUserDisplayName: null,
      isCheer: false,
      bits: 0,
      isRedemption: false,
      rewardId: null,
      sourceBroadcasterId: null,
      sourceBroadcasterLogin: null,
      sourceBroadcasterDisplayName: null,
      sourceChatMessageId: null,
      isSourceOnly: null,
      parts: [],
    };

    const workItem: AiReviewWorkItem = {
      message: syntheticMessage,
      botIdentity,
      processingMode: "live",
      nowMs,
      aiMode: {
        mode: "social",
        signals: {
          mode: "social",
          mentionedBot: false,
          textualMention: false,
          repliedToBot: false,
          threadedWithBot: false,
          rewardTriggered: false,
          broadcasterAddressed: false,
          isFirstTimeChatter: true,
          pollGreetingNames: greetingNames,
        },
      },
      coalescedCount: 1,
      isPollGreeting: true,
    };

    this.aiReviewQueue.enqueue(workItem);
  }

  private resolveNowMs(message: NormalizedChatMessage, nowMs: number | undefined): number {
    if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
      return nowMs;
    }

    const parsed = Date.parse(message.receivedAt);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
}
