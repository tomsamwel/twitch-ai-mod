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
