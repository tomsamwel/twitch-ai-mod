import crypto from "node:crypto";

import { ActionExecutor } from "../actions/action-executor.js";
import { getConfiguredModel } from "../ai/provider-config.js";
import { getAiFailureMetadata } from "../ai/failure-metadata.js";
import { AiContextBuilder } from "../ai/context-builder.js";
import { AiProviderRegistry } from "../ai/provider-registry.js";
import { buildAiDecisionInput } from "../ai/prompt.js";
import type { AiProvider } from "../ai/provider.js";
import { createFixedRuntimeSettings } from "../control/runtime-settings.js";
import { normalizeChatMessage } from "../ingest/normalize-chat-message.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import { RuleEngine } from "../moderation/rule-engine.js";
import { MessageProcessor, type MessageProcessingResult } from "../runtime/message-processor.js";
import { OutboundMessageTracker } from "../runtime/outbound-message-tracker.js";
import { BotDatabase } from "../storage/database.js";
import type {
  ActionRequest,
  ActionResult,
  AiMode,
  ChatMessageEventLike,
  ConfigSnapshot,
  TwitchIdentity,
} from "../types.js";
import type { Logger } from "pino";

import type { ScenarioBotInteractionSpec, ScenarioFile, ScenarioMessageSpec, ScenarioStepSpec } from "./scenario-schema.js";

interface ScenarioRunnerOptions {
  config: ConfigSnapshot;
  logger: Logger;
  aiProvider?: AiProvider;
}

export interface ScenarioEvaluationResult {
  scenarioId: string;
  description: string;
  promptPack: string;
  provider: string;
  model: string;
  stepCount: number;
  passedSteps: number;
  selectedMode: AiMode;
  promptChars: number;
  actualOutcome: "no_action" | "suppressed" | "abstain" | "action" | "ignored";
  actualActionKinds: Array<"say" | "timeout">;
  actualActionStatuses: Array<"executed" | "dry-run" | "skipped" | "failed">;
  replyExcerpt: string | null;
  providerFailureKind: string | null;
  providerErrorType: string | null;
  providerFailureReason: string | null;
  passed: boolean;
  failures: string[];
  steps: ScenarioEvaluationStepResult[];
}

export interface ScenarioEvaluationStepResult {
  stepId: string;
  selectedMode: AiMode;
  promptChars: number;
  actualOutcome: "no_action" | "suppressed" | "abstain" | "action" | "ignored";
  actualActionKinds: Array<"say" | "timeout">;
  actualActionStatuses: Array<"executed" | "dry-run" | "skipped" | "failed">;
  replyExcerpt: string | null;
  providerFailureKind: string | null;
  providerErrorType: string | null;
  providerFailureReason: string | null;
  passed: boolean;
  failures: string[];
}

function rolesToBadges(roles: string[]): Record<string, string> {
  const badges: Record<string, string> = {};

  for (const role of roles) {
    switch (role) {
      case "broadcaster":
        badges.broadcaster = "1";
        break;
      case "moderator":
        badges.moderator = "1";
        break;
      case "vip":
        badges.vip = "1";
        break;
      case "subscriber":
        badges.subscriber = "1";
        break;
      case "trusted":
        badges.staff = "1";
        break;
      default:
        break;
    }
  }

  return badges;
}

function parseMessageParts(text: string): ChatMessageEventLike["messageParts"] {
  const mentionMatcher = /@[a-z0-9_]+/giu;
  const parts: ChatMessageEventLike["messageParts"] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(mentionMatcher)) {
    const value = match[0];
    const startIndex = match.index ?? 0;

    if (startIndex > lastIndex) {
      parts.push({
        type: "text",
        text: text.slice(lastIndex, startIndex),
      });
    }

    parts.push({
      type: "mention",
      text: value,
      mention: {
        user_id: `mention:${value.slice(1).toLowerCase()}`,
        user_login: value.slice(1),
        user_name: value.slice(1),
      },
    });
    lastIndex = startIndex + value.length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      text: text.slice(lastIndex),
    });
  }

  return parts.length > 0 ? parts : [{ type: "text", text }];
}

function createSyntheticEvent(
  message: ScenarioMessageSpec,
  botIdentity: TwitchIdentity,
  broadcasterIdentity: TwitchIdentity,
  eventId: string,
): ChatMessageEventLike {
  const actorDisplayName = message.actor.displayName ?? message.actor.login;

  return {
    messageId: eventId,
    messageText: message.text,
    messageType: "text",
    broadcasterId: broadcasterIdentity.id,
    broadcasterName: broadcasterIdentity.login,
    broadcasterDisplayName: broadcasterIdentity.displayName,
    chatterId: message.actor.id,
    chatterName: message.actor.login,
    chatterDisplayName: actorDisplayName,
    color: null,
    badges: rolesToBadges(message.actor.roles),
    parentMessageId: message.replyToBot ? "bot-parent-message" : null,
    parentMessageUserId: message.replyToBot ? botIdentity.id : null,
    parentMessageUserName: message.replyToBot ? botIdentity.login : null,
    parentMessageUserDisplayName: message.replyToBot ? botIdentity.displayName : null,
    threadMessageId: null,
    threadMessageUserId: null,
    threadMessageUserName: null,
    threadMessageUserDisplayName: null,
    isCheer: false,
    bits: 0,
    isRedemption: false,
    rewardId: null,
    sourceBroadcasterId: null,
    sourceBroadcasterName: null,
    sourceBroadcasterDisplayName: null,
    sourceMessageId: null,
    isSourceOnly: null,
    messageParts: parseMessageParts(message.text),
  };
}

function createSyntheticContext(config: ConfigSnapshot): { broadcaster: TwitchIdentity; bot: TwitchIdentity } {
  const broadcaster: TwitchIdentity = {
    id: "broadcaster-1",
    login: config.twitch.broadcasterLogin,
    displayName: config.twitch.broadcasterLogin,
  };

  if (config.twitch.botLogin.toLowerCase() === config.twitch.broadcasterLogin.toLowerCase()) {
    return {
      broadcaster,
      bot: broadcaster,
    };
  }

  return {
    broadcaster,
    bot: {
      id: "bot-1",
      login: config.twitch.botLogin,
      displayName: config.twitch.botLogin,
    },
  };
}

function seedBotInteraction(
  database: BotDatabase,
  cooldowns: CooldownManager,
  outboundTracker: OutboundMessageTracker,
  interaction: ScenarioBotInteractionSpec,
  targetUser: ScenarioMessageSpec["actor"],
): void {
  const actionId = interaction.id ?? crypto.randomUUID();
  const dryRun = interaction.status !== "executed";
  const sourceMessageId = interaction.externalMessageId ?? `${actionId}-source-message`;
  const action: ActionRequest = {
    id: actionId,
    kind: interaction.kind,
    source: interaction.source,
    sourceEventId: `${actionId}-source-event`,
    sourceMessageId,
    processingMode: "scenario",
    dryRun,
    initiatedAt: interaction.at,
    reason: interaction.reason,
    targetUserId: targetUser.id,
    targetUserName: targetUser.login,
    ...(interaction.message ? { message: interaction.message } : {}),
    ...(interaction.durationSeconds ? { durationSeconds: interaction.durationSeconds } : {}),
  };
  const result: ActionResult = {
    id: action.id,
    kind: action.kind,
    status: interaction.status,
    dryRun,
    reason: action.reason,
    ...(interaction.kind === "say" && interaction.externalMessageId
      ? { externalMessageId: interaction.externalMessageId }
      : {}),
  };

  database.recordAction(action, result);

  if (interaction.status !== "failed") {
    cooldowns.recordAction(action, Date.parse(interaction.at));
  }

  if (interaction.kind === "say" && interaction.externalMessageId) {
    outboundTracker.note(interaction.externalMessageId, Date.parse(interaction.at));
  }
}

function deriveActualOutcome(result: MessageProcessingResult): "no_action" | "suppressed" | "abstain" | "action" | "ignored" {
  if (result.status === "ignored") {
    return "ignored";
  }

  if (result.ruleDecision && result.ruleDecision.outcome !== "no_action") {
    return result.ruleDecision.outcome;
  }

  if (result.aiDecision) {
    return result.aiDecision.outcome;
  }

  return result.ruleDecision?.outcome ?? "no_action";
}

function evaluateScenarioStepResult(
  step: ScenarioStepSpec,
  selectedMode: AiMode,
  result: MessageProcessingResult,
  replyExcerpt: string | null,
): { passed: boolean; failures: string[] } {
  const actualOutcome = deriveActualOutcome(result);
  const actualActionKinds = [
    ...(result.ruleDecision?.actions ?? []),
    ...(result.aiDecision?.actions ?? []),
  ].map((action) => action.kind);
  const actualActionStatuses = result.actionResults.map((action) => action.status);
  const failures: string[] = [];

  if (step.expected.mode && step.expected.mode !== selectedMode) {
    failures.push(`expected mode=${step.expected.mode} but got ${selectedMode}`);
  }

  if (!step.expected.allowedOutcomes.includes(actualOutcome)) {
    failures.push(
      `expected outcome in [${step.expected.allowedOutcomes.join(", ")}] but got ${actualOutcome}`,
    );
  }

  for (const actionKind of actualActionKinds) {
    if (
      step.expected.allowedActionKinds.length > 0 &&
      !step.expected.allowedActionKinds.includes(actionKind)
    ) {
      failures.push(`action kind ${actionKind} is not allowed for this scenario`);
    }
  }

  for (const actionStatus of actualActionStatuses) {
    if (
      step.expected.allowedActionStatuses.length > 0 &&
      !step.expected.allowedActionStatuses.includes(actionStatus)
    ) {
      failures.push(`action status ${actionStatus} is not allowed for this scenario`);
    }
  }

  for (const forbiddenActionKind of step.expected.forbiddenActionKinds) {
    if (actualActionKinds.includes(forbiddenActionKind)) {
      failures.push(`forbidden action kind triggered: ${forbiddenActionKind}`);
    }
  }

  if (step.expected.replyShouldContainAny?.length) {
    const replyText = replyExcerpt?.toLowerCase() ?? "";
    const containsExpected = step.expected.replyShouldContainAny.some((fragment) =>
      replyText.includes(fragment.toLowerCase()),
    );

    if (!containsExpected) {
      failures.push(
        `reply did not contain any of: ${step.expected.replyShouldContainAny.join(", ")}`,
      );
    }
  }

  if (replyExcerpt && step.expected.replyShouldNotContainAny?.length) {
    const replyText = replyExcerpt.toLowerCase();
    const matched = step.expected.replyShouldNotContainAny.find((fragment) =>
      replyText.includes(fragment.toLowerCase()),
    );

    if (matched) {
      failures.push(`reply contained forbidden fragment: ${matched}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

function createScenarioActors(scenario: ScenarioFile): Map<string, ScenarioMessageSpec["actor"]> {
  const actors = new Map<string, ScenarioMessageSpec["actor"]>();

  for (const message of scenario.seed.messages) {
    actors.set(message.actor.id, message.actor);
  }

  for (const step of scenario.steps) {
    actors.set(step.actor.id, step.actor);
  }

  return actors;
}

export async function runScenarioEvaluation(
  scenario: ScenarioFile,
  options: ScenarioRunnerOptions,
): Promise<ScenarioEvaluationResult> {
  const config = structuredClone(options.config);
  config.runtime.dryRun = true;
  config.actions.allowLiveChatMessages = false;
  config.actions.allowLiveModeration = false;

  const database = new BotDatabase(":memory:");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const outboundTracker = new OutboundMessageTracker();
  const contextBuilder = new AiContextBuilder(config, database);
  const runtimeSettings = createFixedRuntimeSettings(config, {
    aiEnabled: config.ai.enabled,
    aiModerationEnabled: false,
    socialRepliesEnabled: true,
    dryRun: true,
    liveModerationEnabled: false,
  });
  const aiProviders = options.aiProvider
    ? {
        createEffectiveConfig() {
          return config;
        },
        async getProvider() {
          return options.aiProvider as AiProvider;
        },
      }
    : new AiProviderRegistry(config, options.logger);
  const actionExecutor = new ActionExecutor(
    config,
    options.logger,
    database,
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("scenario evaluation must not send live chat messages");
      },
      async timeoutUser() {
        throw new Error("scenario evaluation must not execute live moderation");
      },
    },
    runtimeSettings,
  );
  const processor = new MessageProcessor(
    config,
    options.logger,
    database,
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    aiProviders,
    actionExecutor,
    outboundTracker,
  );
  const { broadcaster, bot } = createSyntheticContext(config);
  const scenarioActors = createScenarioActors(scenario);
  const defaultTargetUser = scenario.steps[0]?.actor;

  try {
    for (const [index, historyMessage] of scenario.seed.messages.entries()) {
      const historyEventId = historyMessage.id ?? `${scenario.id}-history-${index + 1}`;
      const normalized = normalizeChatMessage(
        createSyntheticEvent(historyMessage, bot, broadcaster, historyEventId),
        new Date(historyMessage.at),
      );
      database.recordMessageSnapshot(normalized, bot);
    }

    for (const interaction of scenario.seed.botInteractions) {
      const targetUser =
        (interaction.targetActorId ? scenarioActors.get(interaction.targetActorId) : undefined) ?? defaultTargetUser;

      if (!targetUser) {
        throw new Error(`Scenario ${scenario.id} does not have an actor available for seeded interaction targeting.`);
      }

      seedBotInteraction(database, cooldowns, outboundTracker, interaction, targetUser);
    }

    const stepResults: ScenarioEvaluationStepResult[] = [];

    for (const [index, step] of scenario.steps.entries()) {
      const stepEventId = step.id ?? `${scenario.id}-step-${index + 1}`;
      const incomingMessage = normalizeChatMessage(
        createSyntheticEvent(step, bot, broadcaster, stepEventId),
        new Date(step.at),
      );
      const input = buildAiDecisionInput(
        incomingMessage,
        contextBuilder.build(incomingMessage, bot),
        config,
        bot,
      );
      const result = await processor.process(incomingMessage, {
        botIdentity: bot,
        processingMode: "scenario",
        runId: scenario.id,
        forceDryRun: true,
        dedupe: false,
        persistSnapshot: true,
        nowMs: Date.parse(step.at),
      });
      const replyExcerpt =
        result.ruleDecision?.actions.find((action) => action.kind === "say")?.message ??
        result.aiDecision?.actions.find((action) => action.kind === "say")?.message ??
        null;
      const aiFailure = getAiFailureMetadata(result.aiDecision);
      const evaluation = evaluateScenarioStepResult(step, input.mode, result, replyExcerpt);

      stepResults.push({
        stepId: stepEventId,
        selectedMode: input.mode,
        promptChars: input.prompt.system.length + input.prompt.user.length,
        actualOutcome: deriveActualOutcome(result),
        actualActionKinds: [
          ...(result.ruleDecision?.actions ?? []),
          ...(result.aiDecision?.actions ?? []),
        ].map((action) => action.kind),
        actualActionStatuses: result.actionResults.map((action) => action.status),
        replyExcerpt,
        providerFailureKind: aiFailure.failureKind,
        providerErrorType: aiFailure.errorType,
        providerFailureReason: aiFailure.failureKind ? (result.aiDecision?.reason ?? null) : null,
        passed: evaluation.passed,
        failures: evaluation.failures,
      });
    }

    const lastStep = stepResults.at(-1);

    if (!lastStep) {
      throw new Error(`Scenario ${scenario.id} did not produce any step results.`);
    }

    const scenarioFailures = stepResults.flatMap((step) =>
      step.failures.map((failure) => `${step.stepId}: ${failure}`),
    );
    const firstProviderFailure = stepResults.find((step) => step.providerFailureKind) ?? null;

    return {
      scenarioId: scenario.id,
      description: scenario.description,
      promptPack: config.prompts.packName,
      provider: config.ai.provider,
      model: getConfiguredModel(config),
      stepCount: stepResults.length,
      passedSteps: stepResults.filter((step) => step.passed).length,
      selectedMode: lastStep.selectedMode,
      promptChars: Math.max(...stepResults.map((step) => step.promptChars)),
      actualOutcome: lastStep.actualOutcome,
      actualActionKinds: stepResults.flatMap((step) => step.actualActionKinds),
      actualActionStatuses: stepResults.flatMap((step) => step.actualActionStatuses),
      replyExcerpt: lastStep.replyExcerpt,
      providerFailureKind: firstProviderFailure?.providerFailureKind ?? null,
      providerErrorType: firstProviderFailure?.providerErrorType ?? null,
      providerFailureReason: firstProviderFailure?.providerFailureReason ?? null,
      passed: scenarioFailures.length === 0,
      failures: scenarioFailures,
      steps: stepResults,
    };
  } finally {
    database.close();
  }
}
