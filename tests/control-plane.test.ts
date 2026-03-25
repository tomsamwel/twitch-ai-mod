import assert from "node:assert/strict";
import test from "node:test";

import { WhisperControlPlane } from "../src/control/control-plane.js";
import { createLogger } from "../src/storage/logger.js";
import type { EffectiveRuntimeSettings, RuntimeOverrideSnapshot, WhisperMessage } from "../src/types.js";
import { createTestConfig } from "./helpers.js";

function createWhisper(overrides: Partial<WhisperMessage> = {}): WhisperMessage {
  return {
    id: "whisper-1",
    receivedAt: "2026-03-24T10:00:00.000Z",
    recipientUserId: "bot-1",
    recipientUserLogin: "testbot",
    recipientUserDisplayName: "TestBot",
    senderUserId: "streamer-1",
    senderUserLogin: "testchannel",
    senderUserDisplayName: "TestChannel",
    text: "aimod status",
    ...overrides,
  };
}

function createRuntimeSettingsState(config = createTestConfig()): {
  effective: EffectiveRuntimeSettings;
  overrides: RuntimeOverrideSnapshot;
} {
  return {
    effective: {
      aiEnabled: true,
      aiModerationEnabled: false,
      socialRepliesEnabled: true,
      dryRun: true,
      liveModerationEnabled: false,
      promptPack: config.ai.promptPack,
      prompts: config.prompts,
      modelPreset: "local-default",
      provider: config.ai.provider,
      providerBaseUrl: config.ai.ollama.baseUrl,
      model: config.ai.ollama.model,
      lastOverrideAt: null,
      lastOverrideByLogin: null,
    },
    overrides: {
      updatedAt: null,
      updatedByUserId: null,
      updatedByLogin: null,
    },
  };
}

test("WhisperControlPlane denies unauthorized senders without mutating runtime state", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const audits: string[] = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [
      {
        userId: "trusted-1",
        login: "trustedmod",
        displayName: "TrustedMod",
        source: "config",
      },
    ],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride() {
        throw new Error("should not mutate state for unauthorized sender");
      },
      reset() {
        throw new Error("should not reset for unauthorized sender");
      },
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    {
      registerIngestedEvent() {
        return true;
      },
      recordControlAudit(entry) {
        audits.push(entry.commandSummary);
      },
    },
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(
    createWhisper({
      senderUserId: "intruder-1",
      senderUserLogin: "randomviewer",
      senderUserDisplayName: "RandomViewer",
      text: "aimod ai off",
    }),
  );

  assert.equal(sentReplies[0], "You are not allowed to control this bot.");
  assert.deepEqual(audits, ["unauthorized"]);
});

test("WhisperControlPlane applies trusted commands and replies with status", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState(config);
  const sentReplies: string[] = [];
  const audits: string[] = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [
      {
        userId: "streamer-1",
        login: "testchannel",
        displayName: "TestChannel",
        source: "broadcaster",
      },
    ],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride(key, value, actor) {
        state.overrides = {
          ...state.overrides,
          [key]: value,
          updatedAt: "2026-03-24T11:00:00.000Z",
          updatedByUserId: actor.userId,
          updatedByLogin: actor.login,
        };

        if (typeof value === "boolean") {
          if (key === "aiEnabled") {
            state.effective.aiEnabled = value;
          }

          if (key === "aiModerationEnabled") {
            state.effective.aiModerationEnabled = value;
          }
        }
      },
      reset() {
        state.overrides = {
          updatedAt: null,
          updatedByUserId: null,
          updatedByLogin: null,
        };
      },
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    {
      registerIngestedEvent() {
        return true;
      },
      recordControlAudit(entry) {
        audits.push(entry.commandSummary);
      },
    },
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod ai-moderation on" }));
  await controlPlane.processWhisper(createWhisper({ id: "whisper-2", text: "aimod ai off" }));
  await controlPlane.processWhisper(createWhisper({ id: "whisper-3", text: "aimod status" }));

  assert.equal(state.effective.aiEnabled, false);
  assert.equal(state.effective.aiModerationEnabled, true);
  assert.equal(sentReplies[0], "ai-moderation on applied.");
  assert.equal(sentReplies[1], "ai off applied.");
  assert.match(sentReplies[2] ?? "", /ai=off/u);
  assert.match(sentReplies[2] ?? "", /ai-moderation=on/u);
  assert.deepEqual(audits, ["ai-moderation on", "ai off", "status"]);
});

test("WhisperControlPlane ignores duplicate whisper IDs", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const seen = new Set<string>();
  let replyCount = 0;
  let auditCount = 0;

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [
      {
        userId: "streamer-1",
        login: "testchannel",
        displayName: "TestChannel",
        source: "broadcaster",
      },
    ],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride() {},
      reset() {},
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    {
      registerIngestedEvent(eventId) {
        if (seen.has(eventId)) {
          return false;
        }

        seen.add(eventId);
        return true;
      },
      recordControlAudit() {
        auditCount += 1;
      },
    },
    {
      async sendWhisper() {
        replyCount += 1;
      },
    },
  );

  const whisper = createWhisper({ id: "dup-1", text: "aimod status" });
  await controlPlane.processWhisper(whisper);
  await controlPlane.processWhisper(whisper);

  assert.equal(replyCount, 1);
  assert.equal(auditCount, 1);
});
