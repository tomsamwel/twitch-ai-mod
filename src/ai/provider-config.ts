import type { ConfigSnapshot } from "../types.js";

export function getConfiguredProviderInfo(config: Pick<ConfigSnapshot, "ai">): {
  provider: ConfigSnapshot["ai"]["provider"];
  baseUrl: string;
  model: string;
} {
  if (config.ai.provider === "ollama") {
    return {
      provider: "ollama",
      baseUrl: config.ai.ollama.baseUrl,
      model: config.ai.ollama.model,
    };
  }

  return {
    provider: "openai",
    baseUrl: config.ai.openai.baseUrl,
    model: config.ai.openai.model,
  };
}

export function getConfiguredModel(config: Pick<ConfigSnapshot, "ai">): string {
  return getConfiguredProviderInfo(config).model;
}
