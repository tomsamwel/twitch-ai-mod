import type { Logger } from "pino";

import { getProviderSettings, withProviderSettings } from "../ai/provider-config.js";
import type { BotDatabase } from "../storage/database.js";
import type {
  ConfigSnapshot,
  EffectiveRuntimeSettings,
  PromptSnapshot,
  RuntimeOverrideKey,
  RuntimeOverrideSnapshot,
} from "../types.js";

function matchesModelPreset(
  config: ConfigSnapshot,
  preset: { provider: ConfigSnapshot["ai"]["provider"]; baseUrl: string; model: string },
): boolean {
  const providerConfig = getProviderSettings(config, preset.provider);
  if (!providerConfig) return false;
  return (
    config.ai.provider === preset.provider &&
    providerConfig.baseUrl === preset.baseUrl &&
    providerConfig.model === preset.model
  );
}

export interface RuntimeSettingsAccessor {
  getEffectiveSettings(): EffectiveRuntimeSettings;
}

export interface RuntimeResetSummary {
  overrides: number;
  exemptUsers: number;
  blockedTerms: number;
}

export function buildEffectiveRuntimeSettings(
  baseConfig: ConfigSnapshot,
  promptPacks: Map<string, PromptSnapshot>,
  overrides: RuntimeOverrideSnapshot,
): EffectiveRuntimeSettings {
  const rawPromptPack = overrides.promptPack ?? baseConfig.ai.promptPack;
  const promptPackName = promptPacks.has(rawPromptPack) ? rawPromptPack : baseConfig.ai.promptPack;
  const prompts = promptPacks.get(promptPackName) ?? baseConfig.prompts;
  const rawPreset = resolveModelPresetName(baseConfig, overrides.modelPreset);
  const selectedPreset = rawPreset && rawPreset in baseConfig.controlPlane.modelPresets ? rawPreset : null;
  const preset = selectedPreset ? baseConfig.controlPlane.modelPresets[selectedPreset] : null;
  const provider = preset?.provider ?? baseConfig.ai.provider;
  const defaultProviderConfig = getProviderSettings(baseConfig, provider);
  const providerBaseUrl = preset?.baseUrl ?? defaultProviderConfig?.baseUrl ?? baseConfig.ai.ollama.baseUrl;
  const model = preset?.model ?? defaultProviderConfig?.model ?? baseConfig.ai.ollama.model;

  return {
    rules: {
      enabled: overrides.rules?.enabled ?? baseConfig.rules.enabled,
    },
    ai: {
      enabled: overrides.ai?.enabled ?? baseConfig.ai.enabled,
      social: {
        enabled: overrides.ai?.social?.enabled ?? baseConfig.ai.social.enabled,
      },
      moderation: {
        enabled: overrides.ai?.moderation?.enabled ?? baseConfig.ai.moderation.enabled,
        warn: overrides.ai?.moderation?.warn ?? baseConfig.ai.moderation.warn,
        timeout: overrides.ai?.moderation?.timeout ?? baseConfig.ai.moderation.timeout,
      },
    },
    greetingsEnabled: overrides.greetingsEnabled ?? (baseConfig.social?.greetings?.enabled ?? false),
    greetFirstMessage: overrides.greetFirstMessage ?? (baseConfig.social?.greetings?.onFirstMessage ?? true),
    greetOnJoin: overrides.greetOnJoin ?? (baseConfig.social?.greetings?.onChatterJoin ?? false),
    promptPack: promptPackName,
    prompts,
    modelPreset: selectedPreset,
    provider,
    providerBaseUrl,
    model,
    lastOverrideAt: overrides.updatedAt,
    lastOverrideByLogin: overrides.updatedByLogin,
  };
}

export function createEffectiveConfig(
  baseConfig: ConfigSnapshot,
  settings: EffectiveRuntimeSettings,
): ConfigSnapshot {
  const aiWithProvider = withProviderSettings(baseConfig.ai, settings.provider, {
    baseUrl: settings.providerBaseUrl,
    model: settings.model,
  });
  return {
    ...baseConfig,
    prompts: settings.prompts,
    rules: settings.rules,
    ai: {
      ...aiWithProvider,
      enabled: settings.ai.enabled,
      social: settings.ai.social,
      moderation: settings.ai.moderation,
      promptPack: settings.promptPack,
      provider: settings.provider,
    },
  };
}

export function createFixedRuntimeSettings(
  config: ConfigSnapshot,
  overrides: Partial<EffectiveRuntimeSettings> = {},
): RuntimeSettingsAccessor {
  const defaultSettings = buildEffectiveRuntimeSettings(
    config,
    new Map([[config.ai.promptPack, config.prompts]]),
    {
      updatedAt: null,
      updatedByUserId: null,
      updatedByLogin: null,
    },
  );
  const settings: EffectiveRuntimeSettings = {
    ...defaultSettings,
    ...overrides,
  };

  return {
    getEffectiveSettings() {
      return settings;
    },
  };
}

function resolveModelPresetName(
  config: ConfigSnapshot,
  explicitModelPreset: string | undefined,
): string | null {
  if (explicitModelPreset) {
    return explicitModelPreset;
  }

  for (const [presetName, preset] of Object.entries(config.controlPlane.modelPresets)) {
    if (matchesModelPreset(config, preset)) {
      return presetName;
    }
  }

  return null;
}

export class RuntimeSettingsStore {
  private overrides: RuntimeOverrideSnapshot;

  public constructor(
    private readonly baseConfig: ConfigSnapshot,
    private readonly logger: Logger,
    private readonly database: Pick<
      BotDatabase,
      "listRuntimeOverrides" | "setRuntimeOverride" | "clearRuntimeControlState"
    >,
    private readonly promptPacks: Map<string, PromptSnapshot>,
  ) {
    this.overrides = this.loadOverridesFromDatabase();
  }

  public getEffectiveSettings(): EffectiveRuntimeSettings {
    return buildEffectiveRuntimeSettings(this.baseConfig, this.promptPacks, this.overrides);
  }

  public listAvailablePromptPacks(): string[] {
    return [...this.promptPacks.keys()].sort();
  }

  public listAvailableModelPresets(): string[] {
    return Object.keys(this.baseConfig.controlPlane.modelPresets).sort();
  }

  public getOverrides(): RuntimeOverrideSnapshot {
    return { ...this.overrides };
  }

  public setOverride(
    key: RuntimeOverrideKey,
    value: boolean | string,
    actor: { userId: string; login: string },
  ): void {
    this.validateOverride(key, value);
    this.database.setRuntimeOverride(key, value, actor);
    this.overrides = this.loadOverridesFromDatabase();
    this.logger.info({ key, value, actorLogin: actor.login }, "updated runtime override");
  }

  public reset(actor: { userId: string; login: string }): RuntimeResetSummary {
    const summary = this.database.clearRuntimeControlState();
    this.overrides = this.loadOverridesFromDatabase();
    this.logger.warn({ actorLogin: actor.login, ...summary }, "cleared runtime control state");
    return summary;
  }

  private validateOverride(key: RuntimeOverrideKey, value: boolean | string): void {
    switch (key) {
      case "promptPack":
        if (typeof value !== "string") {
          throw new Error("Prompt pack overrides must be strings.");
        }
        if (!this.promptPacks.has(value)) {
          throw new Error(`Unknown prompt pack: ${value}`);
        }
        break;
      case "modelPreset":
        if (typeof value !== "string") {
          throw new Error("Model preset overrides must be strings.");
        }
        if (!(value in this.baseConfig.controlPlane.modelPresets)) {
          throw new Error(`Unknown model preset: ${value}`);
        }
        break;
      default:
        if (typeof value !== "boolean") {
          throw new Error(`Override "${key}" expects a boolean value.`);
        }
        break;
    }
  }

  private loadOverridesFromDatabase(): RuntimeOverrideSnapshot {
    const rows = this.database.listRuntimeOverrides();
    const snapshot: RuntimeOverrideSnapshot = {
      updatedAt: null,
      updatedByUserId: null,
      updatedByLogin: null,
    };

    for (const row of rows) {
      switch (row.key) {
        case "rules.enabled":
          snapshot.rules = { ...(snapshot.rules ?? {}), enabled: row.value as boolean };
          break;
        case "ai.enabled":
          snapshot.ai = { ...(snapshot.ai ?? {}), enabled: row.value as boolean };
          break;
        case "ai.social.enabled":
          snapshot.ai = {
            ...(snapshot.ai ?? {}),
            social: { enabled: row.value as boolean },
          };
          break;
        case "ai.moderation.enabled":
          snapshot.ai = {
            ...(snapshot.ai ?? {}),
            moderation: { ...(snapshot.ai?.moderation ?? {}), enabled: row.value as boolean },
          };
          break;
        case "ai.moderation.warn":
          snapshot.ai = {
            ...(snapshot.ai ?? {}),
            moderation: { ...(snapshot.ai?.moderation ?? {}), warn: row.value as boolean },
          };
          break;
        case "ai.moderation.timeout":
          snapshot.ai = {
            ...(snapshot.ai ?? {}),
            moderation: { ...(snapshot.ai?.moderation ?? {}), timeout: row.value as boolean },
          };
          break;
        case "greetingsEnabled":
          snapshot.greetingsEnabled = row.value as boolean;
          break;
        case "greetFirstMessage":
          snapshot.greetFirstMessage = row.value as boolean;
          break;
        case "greetOnJoin":
          snapshot.greetOnJoin = row.value as boolean;
          break;
        case "promptPack":
          snapshot.promptPack = row.value as string;
          break;
        case "modelPreset":
          snapshot.modelPreset = row.value as string;
          break;
      }

      snapshot.updatedAt = row.updatedAt;
      snapshot.updatedByUserId = row.updatedByUserId;
      snapshot.updatedByLogin = row.updatedByLogin;
    }

    return snapshot;
  }
}
