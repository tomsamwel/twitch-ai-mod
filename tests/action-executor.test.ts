import assert from "node:assert/strict";
import test from "node:test";

import { ActionExecutor } from "../src/actions/action-executor.js";
import { CooldownManager } from "../src/moderation/cooldown-manager.js";
import { createLogger } from "../src/storage/logger.js";
import { createTestConfig, createTestRuntimeSettings } from "./helpers.js";

test("ActionExecutor respects dry-run mode and does not call Twitch", async () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: true,
    liveModerationEnabled: false,
  });

  let sendCalls = 0;
  let timeoutCalls = 0;
  let recordedActions = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {
        recordedActions += 1;
      },
      countRecentTimeoutsForUser(): number {
        return 0;
      },
    },
    cooldowns,
    {
      async sendChatMessage() {
        sendCalls += 1;
        return { id: "sent-1", isSent: true };
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const request = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "test timeout",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
    },
    {
      source: "rules",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
    },
  );

  const result = await executor.execute(request);

  assert.equal(result.status, "dry-run");
  assert.equal(sendCalls, 0);
  assert.equal(timeoutCalls, 0);
  assert.equal(recordedActions, 1);
});

test("ActionExecutor enforces chat cooldowns for repeated live say actions", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: false,
  });

  let sendCalls = 0;
  let recordedActions = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {
        recordedActions += 1;
      },
      countRecentTimeoutsForUser(): number {
        return 0;
      },
    },
    cooldowns,
    {
      async sendChatMessage() {
        sendCalls += 1;
        return { id: `sent-${sendCalls}`, isSent: true };
      },
      async timeoutUser() {
        throw new Error("timeout should not be called in say cooldown test");
      },
    },
    runtimeSettings,
  );

  const first = executor.createActionRequest(
    {
      kind: "say",
      reason: "helpful reply",
      message: "hi there",
      targetUserId: "user-1",
      targetUserName: "viewerone",
    },
    {
      source: "ai",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
      initiatedAt: "2026-03-24T14:00:00.000Z",
    },
  );

  const second = executor.createActionRequest(
    {
      kind: "say",
      reason: "follow-up reply",
      message: "another reply",
      targetUserId: "user-1",
      targetUserName: "viewerone",
    },
    {
      source: "ai",
      sourceEventId: "event-2",
      sourceMessageId: "message-2",
      initiatedAt: "2026-03-24T14:00:05.000Z",
    },
  );

  const firstResult = await executor.execute(first);
  const secondResult = await executor.execute(second);

  assert.equal(firstResult.status, "executed");
  assert.equal(secondResult.status, "skipped");
  assert.match(secondResult.reason, /cooldown/u);
  assert.equal(sendCalls, 1);
  assert.equal(recordedActions, 2);
});

test("ActionExecutor blocks live AI timeout actions unless AI moderation is enabled", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  config.actions.allowLiveModeration = true;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: false,
  });

  let timeoutCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("sendChatMessage should not be called in timeout test");
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const aiRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
    },
    {
      source: "ai",
      sourceEventId: "event-ai",
      sourceMessageId: "message-ai",
      initiatedAt: "2026-03-24T14:10:00.000Z",
      dryRun: false,
    },
  );

  const ruleRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "deterministic escalation",
      targetUserId: "user-2",
      targetUserName: "viewertwo",
      durationSeconds: 60,
    },
    {
      source: "rules",
      sourceEventId: "event-rule",
      sourceMessageId: "message-rule",
      initiatedAt: "2026-03-24T14:10:31.000Z",
      dryRun: false,
    },
  );

  const aiResult = await executor.execute(aiRequest);
  const ruleResult = await executor.execute(ruleRequest);

  assert.equal(aiResult.status, "skipped");
  assert.match(aiResult.reason, /AI live moderation/u);
  assert.equal(ruleResult.status, "executed");
  assert.equal(timeoutCalls, 1);
});

test("ActionExecutor blocks live AI timeout actions when the moderation category is not allowlisted", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  config.actions.allowLiveModeration = true;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: true,
  });

  let timeoutCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("sendChatMessage should not be called in timeout precision test");
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const request = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.95,
        moderationCategory: "soft-promo",
        targetIsPrivileged: false,
        targetIsSelfAuthored: false,
        hasRepeatedUserEvidence: true,
        hasRecentBotCorrectiveInteraction: true,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai",
      sourceMessageId: "message-ai",
      initiatedAt: "2026-03-24T14:10:00.000Z",
      dryRun: false,
    },
  );

  const result = await executor.execute(request);

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "AI timeout blocked by precision gate");
  assert.equal(timeoutCalls, 0);
});

test("ActionExecutor blocks live AI timeout actions when confidence is below the precision gate", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  config.actions.allowLiveModeration = true;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: true,
  });

  let timeoutCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("sendChatMessage should not be called in timeout precision test");
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const request = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.6,
        moderationCategory: "scam",
        targetIsPrivileged: false,
        targetIsSelfAuthored: false,
        hasRepeatedUserEvidence: true,
        hasRecentBotCorrectiveInteraction: true,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai",
      sourceMessageId: "message-ai",
      initiatedAt: "2026-03-24T14:10:00.000Z",
      dryRun: false,
    },
  );

  const result = await executor.execute(request);

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "AI timeout blocked by precision gate");
  assert.equal(timeoutCalls, 0);
});

test("ActionExecutor blocks live AI timeout actions for privileged or self-authored targets", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  config.actions.allowLiveModeration = true;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: true,
  });

  let timeoutCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("sendChatMessage should not be called in timeout precision test");
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const privilegedRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.95,
        moderationCategory: "scam",
        targetIsPrivileged: true,
        targetIsSelfAuthored: false,
        hasRepeatedUserEvidence: true,
        hasRecentBotCorrectiveInteraction: true,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai-1",
      sourceMessageId: "message-ai-1",
      initiatedAt: "2026-03-24T14:10:00.000Z",
      dryRun: false,
    },
  );
  const selfRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-2",
      targetUserName: "viewertwo",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.95,
        moderationCategory: "scam",
        targetIsPrivileged: false,
        targetIsSelfAuthored: true,
        hasRepeatedUserEvidence: true,
        hasRecentBotCorrectiveInteraction: true,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai-2",
      sourceMessageId: "message-ai-2",
      initiatedAt: "2026-03-24T14:11:00.000Z",
      dryRun: false,
    },
  );

  const privilegedResult = await executor.execute(privilegedRequest);
  const selfResult = await executor.execute(selfRequest);

  assert.equal(privilegedResult.status, "skipped");
  assert.equal(selfResult.status, "skipped");
  assert.equal(privilegedResult.reason, "AI timeout blocked by precision gate");
  assert.equal(selfResult.reason, "AI timeout blocked by precision gate");
  assert.equal(timeoutCalls, 0);
});

test("ActionExecutor requires repeat evidence before allowing spam-escalation timeouts", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  config.actions.allowLiveModeration = true;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: true,
  });

  let timeoutCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        throw new Error("sendChatMessage should not be called in timeout precision test");
      },
      async timeoutUser() {
        timeoutCalls += 1;
      },
    },
    runtimeSettings,
  );

  const blockedRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.95,
        moderationCategory: "spam-escalation",
        targetIsPrivileged: false,
        targetIsSelfAuthored: false,
        hasRepeatedUserEvidence: false,
        hasRecentBotCorrectiveInteraction: false,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai-1",
      sourceMessageId: "message-ai-1",
      initiatedAt: "2026-03-24T14:10:00.000Z",
      dryRun: false,
    },
  );
  const allowedRequest = executor.createActionRequest(
    {
      kind: "timeout",
      reason: "AI escalation",
      targetUserId: "user-2",
      targetUserName: "viewertwo",
      durationSeconds: 60,
      metadata: {
        aiConfidence: 0.95,
        moderationCategory: "spam-escalation",
        targetIsPrivileged: false,
        targetIsSelfAuthored: false,
        hasRepeatedUserEvidence: true,
        hasRecentBotCorrectiveInteraction: false,
      },
    },
    {
      source: "ai",
      sourceEventId: "event-ai-2",
      sourceMessageId: "message-ai-2",
      initiatedAt: "2026-03-24T14:11:00.000Z",
      dryRun: false,
    },
  );

  const blockedResult = await executor.execute(blockedRequest);
  const allowedResult = await executor.execute(allowedRequest);

  assert.equal(blockedResult.status, "skipped");
  assert.equal(blockedResult.reason, "AI timeout blocked by precision gate");
  assert.equal(allowedResult.status, "executed");
  assert.equal(timeoutCalls, 1);
});

test("ActionExecutor treats warn actions as moderation notices with reply-parent defaulting and separate cooldowns", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: false,
  });

  const sentPayloads: Array<{ message: string; replyParentMessageId?: string }> = [];

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage(message, replyParentMessageId) {
        sentPayloads.push({
          message,
          ...(replyParentMessageId ? { replyParentMessageId } : {}),
        });
        return { id: `sent-${sentPayloads.length}`, isSent: true };
      },
      async timeoutUser() {
        throw new Error("timeoutUser should not be called in warn test");
      },
    },
    runtimeSettings,
  );

  const sayRequest = executor.createActionRequest(
    {
      kind: "say",
      reason: "social reply",
      message: "Still here.",
      targetUserId: "user-1",
      targetUserName: "viewerone",
    },
    {
      source: "ai",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
      initiatedAt: "2026-03-24T14:00:00.000Z",
      dryRun: false,
    },
  );
  const warnRequest = executor.createActionRequest(
    {
      kind: "warn",
      reason: "public warning",
      message: "Keep it readable.",
      targetUserId: "user-1",
      targetUserName: "viewerone",
    },
    {
      source: "ai",
      sourceEventId: "event-2",
      sourceMessageId: "message-2",
      initiatedAt: "2026-03-24T14:00:05.000Z",
      dryRun: false,
    },
  );

  const sayResult = await executor.execute(sayRequest);
  const warnResult = await executor.execute(warnRequest);

  assert.equal(sayResult.status, "executed");
  assert.equal(warnResult.status, "executed");
  assert.equal(warnRequest.replyParentMessageId, "message-2");
  assert.deepEqual(sentPayloads[1], {
    message: "Keep it readable.",
    replyParentMessageId: "message-2",
  });
});

test("ActionExecutor skips timeout companion warns when the preceding timeout did not execute", async () => {
  const config = createTestConfig();
  config.runtime.dryRun = false;
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: false,
    liveModerationEnabled: true,
    aiModerationEnabled: true,
  });

  let sendCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        sendCalls += 1;
        return { id: "sent-1", isSent: true };
      },
      async timeoutUser() {
        throw new Error("timeoutUser should not be called in companion warn skip test");
      },
    },
    runtimeSettings,
  );

  const request = executor.createActionRequest(
    {
      kind: "warn",
      reason: "public timeout notice",
      message: "That crossed the line.",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      metadata: {
        timeoutCompanion: true,
        companionTimeoutStatus: "skipped",
      },
    },
    {
      source: "ai",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
      initiatedAt: "2026-03-24T14:20:00.000Z",
      dryRun: false,
    },
  );

  const result = await executor.execute(request);

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "timeout notice skipped because the preceding timeout did not execute");
  assert.equal(sendCalls, 0);
});

test("ActionExecutor allows timeout companion warns in dry-run flows when the timeout dry-ran", async () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const logger = createLogger("info", "test");
  const runtimeSettings = createTestRuntimeSettings(config, {
    dryRun: true,
    liveModerationEnabled: false,
  });

  let sendCalls = 0;

  const executor = new ActionExecutor(
    config,
    logger,
    {
      recordAction(): void {},
      countRecentTimeoutsForUser(): number { return 0; },
    },
    cooldowns,
    {
      async sendChatMessage() {
        sendCalls += 1;
        return { id: "sent-1", isSent: true };
      },
      async timeoutUser() {
        throw new Error("timeoutUser should not be called in dry-run companion warn test");
      },
    },
    runtimeSettings,
  );

  const request = executor.createActionRequest(
    {
      kind: "warn",
      reason: "public timeout notice",
      message: "That crossed the line.",
      targetUserId: "user-1",
      targetUserName: "viewerone",
      metadata: {
        timeoutCompanion: true,
        companionTimeoutStatus: "dry-run",
      },
    },
    {
      source: "ai",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
      initiatedAt: "2026-03-24T14:25:00.000Z",
      dryRun: true,
    },
  );

  const result = await executor.execute(request);

  assert.equal(result.status, "dry-run");
  assert.equal(sendCalls, 0);
});
