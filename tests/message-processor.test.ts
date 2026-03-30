import assert from "node:assert/strict";
import test from "node:test";

import { AiContextBuilder } from "../src/ai/context-builder.js";
import { ActionExecutor } from "../src/actions/action-executor.js";
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
      login: "testbot",
      displayName: "TestBot",
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
              moderationCategory: "none",
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
      login: "testbot",
      displayName: "TestBot",
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
  cooldowns.recordAiReview("user-1", "moderation", Date.parse("2026-03-24T12:43:00.000Z"));
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

test("MessageProcessor still evaluates a second direct social reply and records a skipped say action", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  cooldowns.recordAiReview("user-1", "social", Date.parse("2026-03-24T12:50:00.000Z"));
  cooldowns.recordAction(
    {
      kind: "say",
      targetUserId: "user-1",
    },
    Date.parse("2026-03-24T12:50:00.000Z"),
  );
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
      messageId: "social-repeat-2",
      messageText: "@testbot still there?",
      messageParts: [
        {
          type: "mention",
          text: "@testbot",
          mention: {
            user_id: "bot-1",
            user_login: "testbot",
            user_name: "TestBot",
          },
        },
        {
          type: "text",
          text: " still there?",
        },
      ],
    }),
    new Date("2026-03-24T12:50:05.000Z"),
  );
  let aiDecisionRecorded = false;
  let providerCalls = 0;
  const runtimeSettings = createTestRuntimeSettings(config);
  const actionExecutor = new ActionExecutor(
    config,
    logger,
    {
      recordAction() {},
      countRecentTimeoutsForUser() { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("social repeat follow-up should be skipped before sending");
      },
      async timeoutUser() {
        throw new Error("timeout should not be called in social follow-up test");
      },
    },
    runtimeSettings,
  );

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
        aiDecisionRecorded = true;
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
            providerCalls += 1;
            return {
              source: "ollama",
              outcome: "action",
              reason: "brief follow-up answer helps",
              confidence: 0.8,
              mode: "social",
              moderationCategory: "none",
              actions: [
                {
                  kind: "say",
                  reason: "brief follow-up",
                  message: "Still here.",
                },
              ],
            };
          },
        };
      },
    },
    actionExecutor,
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
    nowMs: Date.parse("2026-03-24T12:50:05.000Z"),
  });

  assert.equal(providerCalls, 1);
  assert.equal(aiDecisionRecorded, true);
  assert.equal(result.aiDecision?.outcome, "action");
  assert.equal(result.actionResults[0]?.status, "skipped");
  assert.equal(result.actionResults[0]?.kind, "say");
});

test("MessageProcessor annotates AI timeout actions with precision-gate metadata", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const cooldowns = new CooldownManager(config.cooldowns);
  const ruleEngine = new RuleEngine(config, cooldowns);
  const contextBuilder = new AiContextBuilder(config, {
    listRecentRoomMessageSnapshots() {
      return [];
    },
    listRecentUserMessageSnapshots() {
      return [
        {
          eventId: "prior-user-message",
          sourceMessageId: "prior-user-message",
          chatterId: "user-1",
          chatterLogin: "viewerone",
          receivedAt: "2026-03-24T12:54:00.000Z",
          botIdentity: {
            id: "bot-1",
            login: "testbot",
            displayName: "TestBot",
          },
          message: normalizeChatMessage(createChatEvent(), new Date("2026-03-24T12:54:00.000Z")),
          createdAt: "2026-03-24T12:54:00.000Z",
        },
      ];
    },
    listRecentBotInteractions() {
      return [
        {
          id: "prior-bot-say",
          kind: "say",
          status: "dry-run",
          source: "ai",
          targetUserId: "user-1",
          targetUserName: "viewerone",
          reason: "brief correction",
          dryRun: true,
          processingMode: "live",
          payload: {
            id: "prior-bot-say",
            kind: "say",
            source: "ai",
            sourceEventId: "prior-event",
            sourceMessageId: "prior-message",
            processingMode: "live",
            dryRun: true,
            initiatedAt: "2026-03-24T12:54:10.000Z",
            reason: "brief correction",
            targetUserId: "user-1",
            targetUserName: "viewerone",
            message: "Please stop spamming mentions.",
          },
          result: {
            id: "prior-bot-say",
            kind: "say",
            status: "dry-run",
            dryRun: true,
            reason: "brief correction",
          },
          createdAt: "2026-03-24T12:54:10.000Z",
        },
      ];
    },
  });
  const message = normalizeChatMessage(
    createChatEvent({
      messageId: "timeout-msg-1",
      messageText: "@testbot @testbot @testbot @testbot @testbot",
      messageParts: [
        {
          type: "mention",
          text: "@testbot",
          mention: {
            user_id: "bot-1",
            user_login: "testbot",
            user_name: "TestBot",
          },
        },
        {
          type: "text",
          text: " @testbot @testbot @testbot @testbot",
        },
      ],
    }),
    new Date("2026-03-24T12:55:00.000Z"),
  );
  const runtimeSettings = createTestRuntimeSettings(config);
  const createdRequests: ActionRequest[] = [];

  const processor = new MessageProcessor(
    config,
    logger,
    {
      registerIngestedEvent() {
        return true;
      },
      recordMessageSnapshot() {},
      recordRuleDecision() {},
      recordAiDecision() {},
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
              reason: "repeated mention spam",
              confidence: 0.95,
              mode: "social",
              moderationCategory: "spam-escalation",
              actions: [
                {
                  kind: "timeout",
                  reason: "repeated mention spam",
                  durationSeconds: 300,
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
          id: "action-timeout-1",
          source: input.source,
          sourceEventId: input.sourceEventId,
          sourceMessageId: input.sourceMessageId,
          processingMode: input.processingMode ?? "live",
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

  await processor.process(message, {
    botIdentity: {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    },
    processingMode: "live",
    dedupe: false,
    persistSnapshot: false,
    nowMs: Date.parse("2026-03-24T12:55:00.000Z"),
  });

  assert.equal(createdRequests.length, 1);
  assert.deepEqual(createdRequests[0]?.metadata, {
    aiConfidence: 0.95,
    moderationCategory: "spam-escalation",
    targetIsPrivileged: false,
    targetIsSelfAuthored: false,
    hasRepeatedUserEvidence: true,
    hasRecentBotCorrectiveInteraction: true,
  });
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
