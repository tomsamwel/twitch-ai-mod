import type { Logger } from "pino";

import type { BotDatabase } from "../storage/database.js";
import type {
  ConfigSnapshot,
  EffectiveRuntimeSettings,
  PromptSnapshot,
  RuntimeOverrideKey,
  RuntimeOverrideSnapshot,
} from "../types.js";

function getProviderConfig(
  config: ConfigSnapshot,
  provider: ConfigSnapshot["ai"]["provider"],
): { baseUrl: string; model: string } | undefined {
  if (provider === "ollama") return config.ai.ollama;
  if (provider === "llama-cpp") return config.ai.llamaCpp;
  if (provider === "azure-foundry") {
    return config.ai.azureFoundry
      ? {
          baseUrl: config.ai.azureFoundry.baseUrl,
          model: config.ai.azureFoundry.deployment,
        }
      : undefined;
  }
  if (provider === "openai") return config.ai.openai;
  return undefined;
}

function matchesModelPreset(
  config: ConfigSnapshot,
  preset: { provider: ConfigSnapshot["ai"]["provider"]; baseUrl: string; model: string },
): boolean {
  const providerConfig = getProviderConfig(config, preset.provider);
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
  const defaultProviderConfig = getProviderConfig(baseConfig, provider);
  const providerBaseUrl = preset?.baseUrl ?? defaultProviderConfig?.baseUrl ?? baseConfig.ai.ollama.baseUrl;
  const model = preset?.model ?? defaultProviderConfig?.model ?? baseConfig.ai.ollama.model;

  return {
    aiEnabled: overrides.aiEnabled ?? baseConfig.ai.enabled,
    aiModerationEnabled: overrides.aiModerationEnabled ?? false,
    socialRepliesEnabled: overrides.socialRepliesEnabled ?? true,
    greetingsEnabled: overrides.greetingsEnabled ?? (baseConfig.social?.greetings?.enabled ?? false),
    greetFirstMessage: overrides.greetFirstMessage ?? (baseConfig.social?.greetings?.onFirstMessage ?? true),
    greetOnJoin: overrides.greetOnJoin ?? (baseConfig.social?.greetings?.onChatterJoin ?? false),
    dryRun: overrides.dryRun ?? baseConfig.runtime.dryRun,
    liveModerationEnabled: overrides.liveModerationEnabled ?? baseConfig.actions.allowLiveModeration,
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
  return {
    ...baseConfig,
    runtime: {
      ...baseConfig.runtime,
      dryRun: settings.dryRun,
    },
    prompts: settings.prompts,
    ai: {
      ...baseConfig.ai,
      enabled: settings.aiEnabled,
      promptPack: settings.promptPack,
      provider: settings.provider,
      ollama:
        settings.provider === "ollama"
          ? {
              ...baseConfig.ai.ollama,
              baseUrl: settings.providerBaseUrl,
              model: settings.model,
            }
          : baseConfig.ai.ollama,
      openai:
        settings.provider === "openai"
          ? {
              ...baseConfig.ai.openai,
              baseUrl: settings.providerBaseUrl,
              model: settings.model,
            }
          : baseConfig.ai.openai,
      azureFoundry:
        settings.provider === "azure-foundry"
          ? {
              baseUrl: settings.providerBaseUrl,
              deployment: settings.model,
              apiStyle: baseConfig.ai.azureFoundry?.apiStyle ?? "chat-completions",
            }
          : baseConfig.ai.azureFoundry,
      llamaCpp:
        settings.provider === "llama-cpp" && baseConfig.ai.llamaCpp
          ? {
              ...baseConfig.ai.llamaCpp,
              baseUrl: settings.providerBaseUrl,
              model: settings.model,
            }
          : baseConfig.ai.llamaCpp,
    },
    actions: {
      ...baseConfig.actions,
      allowLiveModeration: settings.liveModerationEnabled,
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
        case "aiEnabled":
          snapshot.aiEnabled = row.value as boolean;
          break;
        case "aiModerationEnabled":
          snapshot.aiModerationEnabled = row.value as boolean;
          break;
        case "socialRepliesEnabled":
          snapshot.socialRepliesEnabled = row.value as boolean;
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
        case "dryRun":
          snapshot.dryRun = row.value as boolean;
          break;
        case "liveModerationEnabled":
          snapshot.liveModerationEnabled = row.value as boolean;
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
