import crypto from "node:crypto";

import type { Logger } from "pino";

import { ActionExecutor } from "../actions/action-executor.js";
import { getAiFailureMetadata } from "../ai/failure-metadata.js";
import { AiContextBuilder } from "../ai/context-builder.js";
import { AiProviderRegistry } from "../ai/provider-registry.js";
import type { AiProvider } from "../ai/provider.js";
import { createFixedRuntimeSettings } from "../control/runtime-settings.js";
import { CooldownManager } from "../moderation/cooldown-manager.js";
import { RuleEngine } from "../moderation/rule-engine.js";
import { MessageProcessor } from "../runtime/message-processor.js";
import type { BotDatabase } from "../storage/database.js";
import type { ActionResult, ConfigSnapshot, PersistedMessageSnapshot } from "../types.js";

export interface ReplayProviderFailureRecord {
  eventId: string;
  chatterLogin: string;
  failureKind: string;
  errorType: string | null;
  reason: string;
}

export interface ReplayTimeoutCandidate {
  eventId: string;
  sourceMessageId: string;
  chatterId: string;
  chatterLogin: string;
  chatterRoles: string[];
  text: string;
  source: "rules" | "ai";
  reason: string;
  status: ActionResult["status"] | null;
}

export interface ReplayEvaluationSummary {
  runId: string;
  messageCount: number;
  processed: number;
  ruleActions: number;
  aiActions: number;
  aiAbstains: number;
  sayActions: number;
  warnActions: number;
  timeoutActions: number;
  providerFailures: ReplayProviderFailureRecord[];
  timeoutCandidates: ReplayTimeoutCandidate[];
}

interface ReplayEvaluationOptions {
  config: ConfigSnapshot;
  logger: Logger;
  database: BotDatabase;
  snapshots: PersistedMessageSnapshot[];
  aiProvider?: AiProvider;
}

export async function runReplayEvaluation(options: ReplayEvaluationOptions): Promise<ReplayEvaluationSummary> {
  const runId = crypto.randomUUID();
  const cooldowns = new CooldownManager(options.config.cooldowns);
  const ruleEngine = new RuleEngine(options.config, cooldowns);
  const contextBuilder = new AiContextBuilder(options.config, options.database);
  const runtimeSettings = createFixedRuntimeSettings(options.config, {
    aiEnabled: options.config.ai.enabled,
    aiModerationEnabled: false,
    socialRepliesEnabled: true,
    dryRun: true,
    liveModerationEnabled: false,
  });
  const aiProviders = options.aiProvider
    ? {
        createEffectiveConfig() {
          return options.config;
        },
        async getProvider() {
          return options.aiProvider as AiProvider;
        },
      }
    : new AiProviderRegistry(options.config, options.logger);
  const actionExecutor = new ActionExecutor(
    options.config,
    options.logger,
    options.database,
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("replay mode must not send live chat messages");
      },
      async timeoutUser() {
        throw new Error("replay mode must not execute live moderation");
      },
    },
    runtimeSettings,
  );
  const messageProcessor = new MessageProcessor(
    options.config,
    options.logger,
    options.database,
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    aiProviders,
    actionExecutor,
  );
  const summary: ReplayEvaluationSummary = {
    runId,
    messageCount: options.snapshots.length,
    processed: 0,
    ruleActions: 0,
    aiActions: 0,
    aiAbstains: 0,
    sayActions: 0,
    warnActions: 0,
    timeoutActions: 0,
    providerFailures: [],
    timeoutCandidates: [],
  };

  for (const snapshot of options.snapshots) {
    const result = await messageProcessor.process(snapshot.message, {
      botIdentity: snapshot.botIdentity,
      processingMode: "replay",
      runId,
      forceDryRun: true,
      dedupe: false,
      persistSnapshot: false,
      nowMs: Date.parse(snapshot.receivedAt),
    });

    if (result.status !== "processed") {
      continue;
    }

    summary.processed += 1;
    summary.ruleActions += result.ruleDecision?.actions.length ?? 0;
    summary.aiActions += result.aiDecision?.actions.length ?? 0;

    if (result.aiDecision?.outcome === "abstain") {
      summary.aiAbstains += 1;
    }

    const proposedActions = [
      ...(result.ruleDecision?.actions.map((action) => ({ action, source: "rules" as const })) ?? []),
      ...(result.aiDecision?.actions.map((action) => ({ action, source: "ai" as const })) ?? []),
    ];

    for (const proposed of proposedActions) {
      if (proposed.action.kind === "say") {
        summary.sayActions += 1;
        continue;
      }

      if (proposed.action.kind === "warn") {
        summary.warnActions += 1;
        continue;
      }

      summary.timeoutActions += 1;
      const matchingResult = result.actionResults.find((actionResult) => actionResult.kind === "timeout") ?? null;
      summary.timeoutCandidates.push({
        eventId: snapshot.eventId,
        sourceMessageId: snapshot.sourceMessageId,
        chatterId: snapshot.message.chatterId,
        chatterLogin: snapshot.message.chatterLogin,
        chatterRoles: snapshot.message.roles,
        text: snapshot.message.text,
        source: proposed.source,
        reason: proposed.action.reason,
        status: matchingResult?.status ?? null,
      });
    }

    const providerFailure = getAiFailureMetadata(result.aiDecision);

    if (providerFailure.failureKind) {
      summary.providerFailures.push({
        eventId: snapshot.eventId,
        chatterLogin: snapshot.message.chatterLogin,
        failureKind: providerFailure.failureKind,
        errorType: providerFailure.errorType,
        reason: result.aiDecision?.reason ?? "unknown provider failure",
      });
    }
  }

  return summary;
}
