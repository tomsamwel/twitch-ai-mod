import assert from "node:assert/strict";
import test from "node:test";

import { AiContextBuilder } from "../src/ai/context-builder.js";
import { MessageProcessor } from "../src/runtime/message-processor.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { RuleEngine } from "../src/moderation/rule-engine.js";
import { CooldownManager } from "../src/moderation/cooldown-manager.js";
import { createLogger } from "../src/storage/logger.js";
import type { ActionRequest, AiDecision, RuleDecision } from "../src/types.js";
import { createChatEvent, createTestConfig, createTestRuntimeSettings } from "./helpers.js";

test("MessageProcessor short-circuits duplicate live messages before snapshotting or decisions", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      return [];
    },
    listRecentUserMessageSnapshots() {
      return [];
    },
    listRecentBotInteractions() {
      return [];
    },
  });
  const duplicateMessage = normalizeChatMessage(createChatEvent());
  const runtimeSettings = createTestRuntimeSettings(config);

  let snapshotCalls = 0;
  let ruleDecisionCalls = 0;
  let aiDecisionCalls = 0;

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return false;
      },
      recordMessageSnapshot() {
        snapshotCalls += 1;
      },
      recordRuleDecision() {
        ruleDecisionCalls += 1;
      },
      recordAiDecision() {
        aiDecisionCalls += 1;
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            throw new Error("AI should not be called for duplicate messages");
          },
        };
      },
    },
    {
      createActionRequest() {
        throw new Error("actions should not be created for duplicate messages");
      },
      async execute() {
        throw new Error("actions should not be executed for duplicate messages");
      },
    },
  );

  const result = await processor.process(duplicateMessage, {
    botIdentity: {
      id: "bot-1",
      login: "testchannel",
      displayName: "Altiventara",
    },
    processingMode: "live",
    dedupe: true,
    persistSnapshot: true,
  });

  assert.equal(result.status, "duplicate");
  assert.equal(snapshotCalls, 0);
  assert.equal(ruleDecisionCalls, 0);
  assert.equal(aiDecisionCalls, 0);
});

test("MessageProcessor replays AI decisions through the shared action flow in dry-run mode", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      return [];
    },
    listRecentUserMessageSnapshots() {
      return [];
    },
    listRecentBotInteractions() {
      return [];
    },
  });
  const replayMessage = normalizeChatMessage(createChatEvent(), new Date("2026-03-24T12:34:56.000Z"));
  const createdRequests: ActionRequest[] = [];
  const recordedContexts: Array<{ stage: "rules" | "ai"; processingMode?: string; runId?: string }> = [];
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: true,
    liveModerationEnabled: false,
  });

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {},
      recordRuleDecision(_message, _decision: RuleDecision, context?: { processingMode?: string; runId?: string }) {
        recordedContexts.push({ stage: "rules", ...context });
      },
      recordAiDecision(_message, _decision: AiDecision, context?: { processingMode?: string; runId?: string }) {
        recordedContexts.push({ stage: "ai", ...context });
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            return {
              source: "ollama",
              outcome: "action",
              reason: "brief reply helps",
              confidence: 0.8,
              mode: "social",
              actions: [
                {
                  kind: "say",
                  reason: "reply briefly",
                  message: "hi there",
                },
              ],
            };
          },
        };
      },
    },
    {
      createActionRequest(action, input) {
        const request: ActionRequest = {
          ...action,
          id: "action-1",
          source: input.source,
          sourceEventId: input.sourceEventId,
          sourceMessageId: input.sourceMessageId,
          processingMode: input.processingMode ?? "live",
          ...(input.runId ? { runId: input.runId } : {}),
          dryRun: input.dryRun ?? config.runtime.dryRun,
          initiatedAt: input.initiatedAt ?? new Date().toISOString(),
        };
        createdRequests.push(request);
        return request;
      },
      async execute(action) {
        return {
          id: action.id,
          kind: action.kind,
          status: action.dryRun ? "dry-run" : "executed",
          dryRun: action.dryRun,
          reason: action.reason,
        };
      },
    },
  );

  const result = await processor.process(replayMessage, {
    botIdentity: {
      id: "bot-1",
      login: "testchannel",
      displayName: "Altiventara",
    },
    processingMode: "replay",
    runId: "run-1",
    forceDryRun: true,
    dedupe: false,
    persistSnapshot: false,
    nowMs: Date.parse("2026-03-24T12:34:56.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.equal(result.ruleDecision?.outcome, "no_action");
  assert.equal(result.aiDecision?.outcome, "action");
  assert.equal(result.actionResults.length, 1);
  assert.equal(createdRequests.length, 1);
  assert.equal(createdRequests[0]?.dryRun, true);
  assert.equal(createdRequests[0]?.processingMode, "replay");
  assert.equal(createdRequests[0]?.runId, "run-1");
  assert.equal(createdRequests[0]?.initiatedAt, "2026-03-24T12:34:56.000Z");
  assert.deepEqual(recordedContexts, [
    { stage: "rules", processingMode: "replay", runId: "run-1" },
    { stage: "ai", processingMode: "replay", runId: "run-1" },
  ]);
});

test("MessageProcessor ignores bot-authored outbound messages after snapshotting", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      return [];
    },
    listRecentUserMessageSnapshots() {
      return [];
    },
    listRecentBotInteractions() {
      return [];
    },
  });
  const message = normalizeChatMessage(
    createChatEvent({
      messageId: "bot-msg-1",
      chatterId: "bot-1",
      chatterName: "testbot",
      chatterDisplayName: "TestBot",
    }),
    new Date("2026-03-24T12:40:00.000Z"),
  );
  const runtimeSettings = createTestRuntimeSettings(config);

  let snapshotCalls = 0;

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {
        snapshotCalls += 1;
      },
      recordRuleDecision() {
        throw new Error("rules should not run for ignored bot-authored messages");
      },
      recordAiDecision() {
        throw new Error("AI should not run for ignored bot-authored messages");
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            throw new Error("AI should not be called for ignored bot-authored messages");
          },
        };
      },
    },
    {
      createActionRequest() {
        throw new Error("actions should not be created for ignored bot-authored messages");
      },
      async execute() {
        throw new Error("actions should not be executed for ignored bot-authored messages");
      },
    },
  );

  const result = await processor.process(message, {
    botIdentity: {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    },
    processingMode: "replay",
    dedupe: false,
    persistSnapshot: true,
  });

  assert.equal(result.status, "ignored");
  assert.equal(snapshotCalls, 1);
});

test("MessageProcessor skips social AI review before building context when social replies are disabled", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      throw new Error("context should not be built when social replies are disabled");
    },
    listRecentUserMessageSnapshots() {
      throw new Error("context should not be built when social replies are disabled");
    },
    listRecentBotInteractions() {
      throw new Error("context should not be built when social replies are disabled");
    },
  });
  const socialMessage = normalizeChatMessage(
    createChatEvent({
      messageId: "social-msg-1",
      messageText: "hello @testbot",
    }),
    new Date("2026-03-24T12:42:00.000Z"),
  );
  const runtimeSettings = createTestRuntimeSettings(config, {
    socialRepliesEnabled: false,
  });

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {},
      recordRuleDecision() {},
      recordAiDecision() {
        throw new Error("AI decision should not be recorded when social replies are disabled");
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            throw new Error("AI should not be called when social replies are disabled");
          },
        };
      },
    },
    {
      createActionRequest() {
        throw new Error("actions should not be created when social replies are disabled");
      },
      async execute() {
        throw new Error("actions should not be executed when social replies are disabled");
      },
    },
  );

  const result = await processor.process(socialMessage, {
    botIdentity: {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    },
    processingMode: "live",
    dedupe: false,
    persistSnapshot: false,
  });

  assert.equal(result.status, "processed");
  assert.equal(result.aiDecision, null);
  assert.equal(result.actionResults.length, 0);
});

test("MessageProcessor skips AI cooldown-suppressed reviews before building context", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  cooldowns.recordAiReview("user-1", Date.parse("2026-03-24T12:43:00.000Z"));
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      throw new Error("context should not be built when AI review cooldown is active");
    },
    listRecentUserMessageSnapshots() {
      throw new Error("context should not be built when AI review cooldown is active");
    },
    listRecentBotInteractions() {
      throw new Error("context should not be built when AI review cooldown is active");
    },
  });
  const message = normalizeChatMessage(
    createChatEvent({
      messageId: "cooldown-msg-1",
    }),
    new Date("2026-03-24T12:43:05.000Z"),
  );
  const runtimeSettings = createTestRuntimeSettings(config);

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {},
      recordRuleDecision() {},
      recordAiDecision() {
        throw new Error("AI decision should not be recorded when review cooldown is active");
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            throw new Error("AI should not be called when review cooldown is active");
          },
        };
      },
    },
    {
      createActionRequest() {
        throw new Error("actions should not be created when review cooldown is active");
      },
      async execute() {
        throw new Error("actions should not be executed when review cooldown is active");
      },
    },
  );

  const result = await processor.process(message, {
    botIdentity: {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    },
    processingMode: "live",
    dedupe: false,
    persistSnapshot: false,
    nowMs: Date.parse("2026-03-24T12:43:05.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.equal(result.aiDecision, null);
  assert.equal(result.actionResults.length, 0);
});

test("MessageProcessor skips AI moderation for privileged chatters unless the mode is social", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      throw new Error("context should not be built for privileged moderation messages");
    },
    listRecentUserMessageSnapshots() {
      throw new Error("context should not be built for privileged moderation messages");
    },
    listRecentBotInteractions() {
      throw new Error("context should not be built for privileged moderation messages");
    },
  });
  const privilegedMessage = normalizeChatMessage(
    createChatEvent({
      messageId: "mod-msg-1",
      chatterId: "mod-1",
      chatterName: "trustedmod",
      chatterDisplayName: "TrustedMod",
      badges: {
        moderator: "1",
      },
      messageText: "buy followers now",
    }),
    new Date("2026-03-24T12:45:00.000Z"),
  );
  const runtimeSettings = createTestRuntimeSettings(config);

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {},
      recordRuleDecision() {},
      recordAiDecision() {
        throw new Error("AI decision should not be recorded for privileged moderation messages");
      },
    },
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    {
      createEffectiveConfig() {
        return config;
      },
      async getProvider() {
        return {
          kind: "ollama",
          async healthCheck() {},
          async decide(): Promise<AiDecision> {
            throw new Error("AI should not be called for privileged moderation messages");
          },
        };
      },
    },
    {
      createActionRequest() {
        throw new Error("actions should not be created for privileged moderation messages");
      },
      async execute() {
        throw new Error("actions should not be executed for privileged moderation messages");
      },
    },
  );

  const result = await processor.process(privilegedMessage, {
    botIdentity: {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    },
    processingMode: "live",
    dedupe: false,
    persistSnapshot: false,
  });

  assert.equal(result.status, "processed");
  assert.equal(result.ruleDecision?.outcome, "no_action");
  assert.equal(result.aiDecision, null);
  assert.equal(result.actionResults.length, 0);
});
