import type { AiProviderKind, ConfigSnapshot } from "../types.js";

type AiConfig = ConfigSnapshot["ai"];
export interface ProviderSettings {
  baseUrl: string;
  model: string;
}

export function getProviderSettings(
  config: Pick<ConfigSnapshot, "ai">,
  provider: AiProviderKind = config.ai.provider,
): ProviderSettings | undefined {
  const ai = config.ai;
  switch (provider) {
    case "ollama":
      return { baseUrl: ai.ollama.baseUrl, model: ai.ollama.model };
    case "openai":
      return { baseUrl: ai.openai.baseUrl, model: ai.openai.model };
    case "azure-foundry":
      return ai.azureFoundry
        ? { baseUrl: ai.azureFoundry.baseUrl, model: ai.azureFoundry.deployment }
        : undefined;
    case "llama-cpp":
      return ai.llamaCpp
        ? { baseUrl: ai.llamaCpp.baseUrl, model: ai.llamaCpp.model }
        : undefined;
  }
}

export function getConfiguredProviderInfo(config: Pick<ConfigSnapshot, "ai">): {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
} {
  const provider = config.ai.provider;
  const settings = getProviderSettings(config, provider);
  if (!settings) {
    throw new Error(`ai.${providerConfigKey(provider)} configuration is required when provider is ${provider}`);
  }
  return { provider, ...settings };
}

export function getConfiguredModel(config: Pick<ConfigSnapshot, "ai">): string {
  return getConfiguredProviderInfo(config).model;
}

export function withProviderSettings(
  ai: AiConfig,
  provider: AiProviderKind,
  settings: ProviderSettings,
): AiConfig {
  switch (provider) {
    case "ollama":
      return { ...ai, ollama: { ...ai.ollama, baseUrl: settings.baseUrl, model: settings.model } };
    case "openai":
      return { ...ai, openai: { ...ai.openai, baseUrl: settings.baseUrl, model: settings.model } };
    case "azure-foundry":
      return {
        ...ai,
        azureFoundry: {
          baseUrl: settings.baseUrl,
          deployment: settings.model,
          apiStyle: ai.azureFoundry?.apiStyle ?? "chat-completions",
        },
      };
    case "llama-cpp":
      if (!ai.llamaCpp) return ai;
      return { ...ai, llamaCpp: { ...ai.llamaCpp, baseUrl: settings.baseUrl, model: settings.model } };
  }
}

function providerConfigKey(provider: AiProviderKind): string {
  switch (provider) {
    case "azure-foundry":
      return "azureFoundry";
    case "llama-cpp":
      return "llamaCpp";
    default:
      return provider;
  }
}
