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

function createMockDatabase(overrides: Record<string, unknown> = {}) {
  return {
    registerIngestedEvent() { return true; },
    recordControlAudit() {},
    getRecentDecisionsForAdmin() { return []; },
    getHourlyStats() { return { decisions: { total: 0, byOutcome: {} }, actions: { total: 0, byKind: {}, byStatus: {} }, timeouts: { total: 0, bySource: {} } }; },
    addExemptUser() { return true; },
    removeExemptUser() { return true; },
    listExemptUsers() { return []; },
    addRuntimeBlockedTerm() { return true; },
    removeRuntimeBlockedTerm() { return true; },
    listRuntimeBlockedTerms() { return []; },
    getRuntimeControllerByUserId() { return null; },
    touchRuntimeControllerIdentity() { return false; },
    purgeUserHistory() { return { messages: 0, decisions: 0, actions: 0 }; },
    purgeOperationalData() { return { messages: 0, decisions: 0, actions: 0, events: 0, reviews: 0, greetedUsers: 0 }; },
    ...overrides,
  };
}

function createRuntimeSettingsState(config = createTestConfig()): {
  effective: EffectiveRuntimeSettings;
  overrides: RuntimeOverrideSnapshot;
} {
  return {
    effective: {
      rules: { enabled: true },
      ai: {
        enabled: true,
        social: { enabled: true },
        moderation: { enabled: false, warn: true, timeout: true },
      },
      greetingsEnabled: false,
      greetFirstMessage: true,
      greetOnJoin: false,
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
        role: "admin",
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
    createMockDatabase({ recordControlAudit(entry: { commandSummary: string }) { audits.push(entry.commandSummary); } }),
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

test("WhisperControlPlane authorizes runtime controllers by stable user ID", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  let touchedIdentity: { userId: string; login: string; displayName: string } | null = null;

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride() {
        throw new Error("status should not mutate overrides");
      },
      reset() {
        throw new Error("status should not reset");
      },
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    createMockDatabase({
      getRuntimeControllerByUserId(userId: string) {
        if (userId !== "runtime-1") {
          return null;
        }
        return {
          login: "oldlogin",
          userId,
          displayName: "Old Login",
          role: "admin" as const,
          addedByLogin: "local-admin",
          createdAt: "2026-03-24T10:00:00.000Z",
          updatedAt: "2026-03-24T10:00:00.000Z",
        };
      },
      touchRuntimeControllerIdentity(userId: string, login: string, displayName: string) {
        touchedIdentity = { userId, login, displayName };
        return true;
      },
    }),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(
    createWhisper({
      senderUserId: "runtime-1",
      senderUserLogin: "renamedmod",
      senderUserDisplayName: "RenamedMod",
      text: "aimod status",
    }),
  );

  assert.match(sentReplies[0] ?? "", /ai=/u);
  assert.deepEqual(touchedIdentity, {
    userId: "runtime-1",
    login: "renamedmod",
    displayName: "RenamedMod",
  });
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
        role: "broadcaster",
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
          if (key === "ai.enabled") {
            state.effective.ai.enabled = value;
          }

          if (key === "ai.moderation.enabled") {
            state.effective.ai.moderation.enabled = value;
          }
        }
      },
      reset() {
        state.overrides = {
          updatedAt: null,
          updatedByUserId: null,
          updatedByLogin: null,
        };
        return {
          overrides: 0,
          exemptUsers: 0,
          blockedTerms: 0,
        };
      },
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    createMockDatabase({ recordControlAudit(entry: { commandSummary: string }) { audits.push(entry.commandSummary); } }),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod mod on" }));
  await controlPlane.processWhisper(createWhisper({ id: "whisper-2", text: "aimod ai off" }));
  await controlPlane.processWhisper(createWhisper({ id: "whisper-3", text: "aimod status" }));

  assert.equal(state.effective.ai.enabled, false);
  assert.equal(state.effective.ai.moderation.enabled, true);
  assert.equal(sentReplies[0], "mod on applied.");
  assert.equal(sentReplies[1], "ai off applied.");
  assert.match(sentReplies[2] ?? "", /ai=off/u);
  assert.match(sentReplies[2] ?? "", /mod=on/u);
  assert.deepEqual(audits, ["mod on", "ai off", "status"]);
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
        role: "broadcaster",
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
      reset() {
        return { overrides: 0, exemptUsers: 0, blockedTerms: 0 };
      },
      listAvailablePromptPacks() {
        return ["witty-mod", "safer-control"];
      },
      listAvailableModelPresets() {
        return ["local-default", "local-fast"];
      },
    },
    createMockDatabase({
      registerIngestedEvent(eventId: string) {
        if (seen.has(eventId)) return false;
        seen.add(eventId);
        return true;
      },
      recordControlAudit() { auditCount += 1; },
    }),
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

test("WhisperControlPlane panic command enables every gate in the tree", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const appliedOverrides: Array<{ key: string; value: unknown }> = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "streamer-1", login: "testchannel", displayName: "TestChannel", source: "broadcaster", role: "broadcaster" as const }],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride(key, value) {
        appliedOverrides.push({ key, value });
      },
      reset() {
        return { overrides: 0, exemptUsers: 0, blockedTerms: 0 };
      },
      listAvailablePromptPacks() {
        return ["witty-mod"];
      },
      listAvailableModelPresets() {
        return ["local-default"];
      },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod panic" }));

  assert.match(sentReplies[0] ?? "", /PANIC MODE/u);
  assert.deepEqual(appliedOverrides, [
    { key: "rules.enabled", value: true },
    { key: "ai.enabled", value: true },
    { key: "ai.social.enabled", value: true },
    { key: "ai.moderation.enabled", value: true },
    { key: "ai.moderation.warn", value: true },
    { key: "ai.moderation.timeout", value: true },
  ]);
});

test("WhisperControlPlane chill command enables AI + social, disables moderation", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const appliedOverrides: Array<{ key: string; value: unknown }> = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "streamer-1", login: "testchannel", displayName: "TestChannel", source: "broadcaster", role: "broadcaster" as const }],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride(key, value) {
        appliedOverrides.push({ key, value });
      },
      reset() {
        return { overrides: 0, exemptUsers: 0, blockedTerms: 0 };
      },
      listAvailablePromptPacks() {
        return ["witty-mod"];
      },
      listAvailableModelPresets() {
        return ["local-default"];
      },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod chill" }));

  assert.match(sentReplies[0] ?? "", /CHILL MODE/u);
  assert.deepEqual(appliedOverrides, [
    { key: "rules.enabled", value: true },
    { key: "ai.enabled", value: true },
    { key: "ai.social.enabled", value: true },
    { key: "ai.moderation.enabled", value: false },
  ]);
});

test("WhisperControlPlane off command disables AI", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const appliedOverrides: Array<{ key: string; value: unknown }> = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "streamer-1", login: "testchannel", displayName: "TestChannel", source: "broadcaster", role: "broadcaster" as const }],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride(key, value) {
        appliedOverrides.push({ key, value });
      },
      reset() {
        return { overrides: 0, exemptUsers: 0, blockedTerms: 0 };
      },
      listAvailablePromptPacks() {
        return ["witty-mod"];
      },
      listAvailableModelPresets() {
        return ["local-default"];
      },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod off" }));

  assert.match(sentReplies[0] ?? "", /OFF/u);
  assert.deepEqual(appliedOverrides, [
    { key: "rules.enabled", value: false },
    { key: "ai.enabled", value: false },
  ]);
});

test("mod role is denied from set-ai but allowed for status", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "mod-1", login: "channelmod", displayName: "ChannelMod", source: "config", role: "mod" as const }],
    logger,
    {
      getEffectiveSettings() {
        return state.effective;
      },
      getOverrides() {
        return state.overrides;
      },
      setOverride() {
        throw new Error("should not mutate state for mod role on set-ai");
      },
      reset() {
        throw new Error("should not reset for mod role");
      },
      listAvailablePromptPacks() {
        return ["witty-mod"];
      },
      listAvailableModelPresets() {
        return ["local-default"];
      },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) {
        sentReplies.push(message);
      },
    },
  );

  await controlPlane.processWhisper(
    createWhisper({ senderUserId: "mod-1", senderUserLogin: "channelmod", text: "aimod ai on" }),
  );
  assert.match(sentReplies[0] ?? "", /don't have permission/u);

  sentReplies.length = 0;
  await controlPlane.processWhisper(
    createWhisper({ id: "whisper-2", senderUserId: "mod-1", senderUserLogin: "channelmod", text: "aimod status" }),
  );
  assert.match(sentReplies[0] ?? "", /ai=/u);
});

test("WhisperControlPlane greet-first-message command toggles greetFirstMessage override", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const appliedOverrides: Array<{ key: string; value: unknown }> = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "streamer-1", login: "testchannel", displayName: "TestChannel", source: "broadcaster", role: "broadcaster" as const }],
    logger,
    {
      getEffectiveSettings() { return state.effective; },
      getOverrides() { return state.overrides; },
      setOverride(key, value) { appliedOverrides.push({ key, value }); },
      reset() { return { overrides: 0, exemptUsers: 0, blockedTerms: 0 }; },
      listAvailablePromptPacks() { return ["witty-mod"]; },
      listAvailableModelPresets() { return ["local-default"]; },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) { sentReplies.push(message); },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod gfm off" }));

  assert.ok(sentReplies[0]?.includes("greet-first-message"), `reply should mention greet-first-message, got: ${sentReplies[0]}`);
  assert.deepEqual(appliedOverrides, [{ key: "greetFirstMessage", value: false }]);
});

test("WhisperControlPlane greet-on-join command toggles greetOnJoin override", async () => {
  const logger = createLogger("info", "test");
  const state = createRuntimeSettingsState();
  const sentReplies: string[] = [];
  const appliedOverrides: Array<{ key: string; value: unknown }> = [];

  const controlPlane = new WhisperControlPlane(
    "aimod",
    [{ userId: "streamer-1", login: "testchannel", displayName: "TestChannel", source: "broadcaster", role: "broadcaster" as const }],
    logger,
    {
      getEffectiveSettings() { return state.effective; },
      getOverrides() { return state.overrides; },
      setOverride(key, value) { appliedOverrides.push({ key, value }); },
      reset() { return { overrides: 0, exemptUsers: 0, blockedTerms: 0 }; },
      listAvailablePromptPacks() { return ["witty-mod"]; },
      listAvailableModelPresets() { return ["local-default"]; },
    },
    createMockDatabase(),
    {
      async sendWhisper(_targetUserId, message) { sentReplies.push(message); },
    },
  );

  await controlPlane.processWhisper(createWhisper({ text: "aimod goj on" }));

  assert.ok(sentReplies[0]?.includes("greet-on-join"), `reply should mention greet-on-join, got: ${sentReplies[0]}`);
  assert.deepEqual(appliedOverrides, [{ key: "greetOnJoin", value: true }]);
});
