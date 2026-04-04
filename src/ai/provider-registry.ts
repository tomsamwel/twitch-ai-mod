import type { Logger } from "pino";

import { getConfiguredProviderInfo } from "./provider-config.js";
import { LlamaCppAiProvider } from "./providers/llama-cpp.js";
import { OllamaAiProvider } from "./providers/ollama.js";
import { OpenAiAiProvider } from "./providers/openai.js";
import type { AiProvider } from "./provider.js";
import { createEffectiveConfig } from "../control/runtime-settings.js";
import type { ConfigSnapshot, EffectiveRuntimeSettings } from "../types.js";

function instantiateAiProvider(config: ConfigSnapshot, logger: Logger): AiProvider {
  const registry = {
    ollama: () => new OllamaAiProvider(config, logger),
    openai: () => new OpenAiAiProvider(config, logger),
    "llama-cpp": () => new LlamaCppAiProvider(config, logger),
  } as const;

  return registry[config.ai.provider]();
}

export async function createAiProvider(config: ConfigSnapshot, logger: Logger): Promise<AiProvider> {
  const provider = instantiateAiProvider(config, logger);
  if (config.ai.enabled && config.moderationPolicy.aiPolicy.enabled) {
    await provider.healthCheck();
  }

  logger.info({ provider: provider.kind }, "initialized AI provider");
  return provider;
}

export class AiProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();
  private readonly pending = new Map<string, Promise<AiProvider>>();

  public constructor(
    private readonly baseConfig: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  public createEffectiveConfig(settings: EffectiveRuntimeSettings): ConfigSnapshot {
    return createEffectiveConfig(this.baseConfig, settings);
  }

  public async getProvider(config: ConfigSnapshot): Promise<AiProvider> {
    const { provider: providerKind, baseUrl, model } = getConfiguredProviderInfo(config);
    const cacheKey = `${providerKind}|${baseUrl}|${model}`;

    const existing = this.providers.get(cacheKey);
    if (existing) return existing;

    const inflight = this.pending.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
      const provider = instantiateAiProvider(config, this.logger);
      if (config.ai.enabled && config.moderationPolicy.aiPolicy.enabled) {
        await provider.healthCheck();
      }
      this.providers.set(cacheKey, provider);
      this.logger.info({ provider: provider.kind, model }, "initialized AI provider for runtime settings");
      return provider;
    })();

    this.pending.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(cacheKey);
    }
  }
}
