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
      key: "ai.enabled" as const,
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
      key: "ai.moderation.enabled" as const,
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
      clearRuntimeControlState() {
        cleared = true;
        return {
          overrides: persistedOverrides.length,
          exemptUsers: 0,
          blockedTerms: 0,
        };
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
  assert.equal(effective.ai.enabled, false);
  assert.equal(effective.ai.moderation.enabled, true);
  assert.equal(effective.promptPack, "safer-control");
  assert.equal(effective.lastOverrideByLogin, "streamer");

  store.setOverride("modelPreset", "local-fast", {
    userId: "user-1",
    login: "streamer",
  });
  assert.deepEqual(writes, [{ key: "modelPreset", value: "local-fast" }]);

  const resetSummary = store.reset({
    userId: "user-1",
    login: "streamer",
  });
  assert.deepEqual(resetSummary, {
    overrides: persistedOverrides.length,
    exemptUsers: 0,
    blockedTerms: 0,
  });

  const resetEffective = store.getEffectiveSettings();
  assert.equal(resetEffective.ai.enabled, config.ai.enabled);
  assert.equal(resetEffective.ai.moderation.enabled, config.ai.moderation.enabled);
  assert.equal(resetEffective.promptPack, config.ai.promptPack);
});

test("createFixedRuntimeSettings and createEffectiveConfig produce a consistent effective config", () => {
  const config = createTestConfig();
  const runtimeSettings = createFixedRuntimeSettings(config, {
    rules: { enabled: true },
    ai: {
      enabled: false,
      social: { enabled: false },
      moderation: { enabled: false, warn: true, timeout: true },
    },
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
  assert.equal(effectiveConfig.rules.enabled, true);
  assert.equal(effectiveConfig.ai.ollama.model, "qwen2.5:1.5b");
  assert.equal(effective.ai.moderation.enabled, false);
});

test("createEffectiveConfig maps Azure AI Foundry runtime settings onto deployment config", () => {
  const config = createTestConfig();
  const runtimeSettings = createFixedRuntimeSettings(config, {
    provider: "azure-foundry",
    providerBaseUrl: "https://custom-resource.openai.azure.com/openai/v1/",
    model: "mod-bot-prod",
  });

  const effectiveConfig = createEffectiveConfig(config, runtimeSettings.getEffectiveSettings());

  assert.equal(effectiveConfig.ai.provider, "azure-foundry");
  assert.equal(effectiveConfig.ai.azureFoundry?.baseUrl, "https://custom-resource.openai.azure.com/openai/v1/");
  assert.equal(effectiveConfig.ai.azureFoundry?.deployment, "mod-bot-prod");
  assert.equal(effectiveConfig.ai.azureFoundry?.apiStyle, "chat-completions");
});
