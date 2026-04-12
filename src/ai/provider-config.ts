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

  if (config.ai.provider === "llama-cpp") {
    if (!config.ai.llamaCpp) {
      throw new Error("ai.llamaCpp configuration is required when provider is llama-cpp");
    }
    return {
      provider: "llama-cpp",
      baseUrl: config.ai.llamaCpp.baseUrl,
      model: config.ai.llamaCpp.model,
    };
  }

  if (config.ai.provider === "azure") {
    if (!config.ai.azure) {
      throw new Error("ai.azure configuration is required when provider is azure");
    }
    return {
      provider: "azure",
      baseUrl: config.ai.azure.baseUrl,
      model: config.ai.azure.model,
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
