import assert from "node:assert/strict";
import test from "node:test";

import {
  createEffectiveConfig,
  createFixedRuntimeSettings,
  RuntimeSettingsStore,
} from "../src/control/runtime-settings.js";
import { createLogger } from "../src/storage/logger.js";
import { createTestConfig } from "./helpers.js";

test("RuntimeSettingsStore applies persisted overrides and can reset to defaults", () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const persistedOverrides = [
    {
      key: "aiEnabled" as const,
      value: false,
      updatedAt: "2026-03-24T10:00:00.000Z",
      updatedByUserId: "user-1",
      updatedByLogin: "streamer",
    },
    {
      key: "promptPack" as const,
      value: "safer-control",
      updatedAt: "2026-03-24T10:00:05.000Z",
      updatedByUserId: "user-1",
      updatedByLogin: "streamer",
    },
    {
      key: "aiModerationEnabled" as const,
      value: true,
      updatedAt: "2026-03-24T10:00:06.000Z",
      updatedByUserId: "user-1",
      updatedByLogin: "streamer",
    },
  ];
  const writes: Array<{ key: string; value: unknown }> = [];
  let cleared = false;

  const store = new RuntimeSettingsStore(
    config,
    logger,
    {
      listRuntimeOverrides() {
        return cleared ? [] : persistedOverrides;
      },
      setRuntimeOverride(key, value) {
        writes.push({ key, value });
      },
      clearRuntimeOverrides() {
        cleared = true;
      },
    },
    new Map([
      ["witty-mod", config.prompts],
      [
        "safer-control",
        {
          ...config.prompts,
          packName: "safer-control",
        },
      ],
    ]),
  );

  const effective = store.getEffectiveSettings();
  assert.equal(effective.aiEnabled, false);
  assert.equal(effective.aiModerationEnabled, true);
  assert.equal(effective.promptPack, "safer-control");
  assert.equal(effective.lastOverrideByLogin, "streamer");

  store.setOverride("modelPreset", "local-fast", {
    userId: "user-1",
    login: "streamer",
  });
  assert.deepEqual(writes, [{ key: "modelPreset", value: "local-fast" }]);

  store.reset({
    userId: "user-1",
    login: "streamer",
  });

  const resetEffective = store.getEffectiveSettings();
  assert.equal(resetEffective.aiEnabled, config.ai.enabled);
  assert.equal(resetEffective.aiModerationEnabled, false);
  assert.equal(resetEffective.promptPack, config.ai.promptPack);
});

test("createFixedRuntimeSettings and createEffectiveConfig produce a consistent effective config", () => {
  const config = createTestConfig();
  const runtimeSettings = createFixedRuntimeSettings(config, {
    aiEnabled: false,
    aiModerationEnabled: false,
    socialRepliesEnabled: false,
    dryRun: false,
    liveModerationEnabled: true,
    promptPack: "safer-control",
    prompts: {
      ...config.prompts,
      packName: "safer-control",
    },
    modelPreset: "local-fast",
    provider: "ollama",
    providerBaseUrl: "http://localhost:11434",
    model: "qwen2.5:1.5b",
  });

  const effective = runtimeSettings.getEffectiveSettings();
  const effectiveConfig = createEffectiveConfig(config, effective);

  assert.equal(effectiveConfig.ai.enabled, false);
  assert.equal(effectiveConfig.ai.promptPack, "safer-control");
  assert.equal(effectiveConfig.prompts.packName, "safer-control");
  assert.equal(effectiveConfig.runtime.dryRun, false);
  assert.equal(effectiveConfig.actions.allowLiveModeration, true);
  assert.equal(effectiveConfig.ai.ollama.model, "qwen2.5:1.5b");
  assert.equal(effective.aiModerationEnabled, false);
});
