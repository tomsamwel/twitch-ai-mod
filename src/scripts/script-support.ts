import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import { getProviderSettings, withProviderSettings } from "../ai/provider-config.js";
import { LlamaServerManager } from "../admin/llama-server-manager.js";
import type { AiProviderKind, ConfigSnapshot } from "../types.js";

export { getConfiguredModel as getActiveModel } from "../ai/provider-config.js";

export interface NonLiveScriptOptions {
  provider?: AiProviderKind;
  model?: string;
}

export function applyNonLiveScriptOverrides(
  config: ConfigSnapshot,
  options: NonLiveScriptOptions = {},
): ConfigSnapshot {
  const nextConfig = structuredClone(config);
  const provider = options.provider ?? nextConfig.ai.provider;

  nextConfig.ai.provider = provider;
  nextConfig.rules.enabled = false;
  nextConfig.ai.social.enabled = false;
  nextConfig.ai.moderation.enabled = false;
  nextConfig.ai.moderation.warn = false;
  nextConfig.ai.moderation.timeout = false;
  nextConfig.actions.allowLiveChatMessages = false;

  if (options.model) {
    const current = getProviderSettings(nextConfig, provider);
    if (!current) {
      throw new Error(`ai.${provider === "azure-foundry" ? "azureFoundry" : "llamaCpp"} configuration is required when provider is ${provider}`);
    }
    nextConfig.ai = withProviderSettings(nextConfig.ai, provider, {
      baseUrl: current.baseUrl,
      model: options.model,
    });
  }

  return nextConfig;
}

export async function ensureLlamaServer(
  config: ConfigSnapshot,
  logger: Logger,
): Promise<LlamaServerManager | null> {
  if (config.ai.provider !== "llama-cpp" || !config.ai.llamaCpp?.managed) {
    return null;
  }

  const manager = new LlamaServerManager({
    logger,
    modelTag: config.ai.llamaCpp.model,
    port: Number(new URL(config.ai.llamaCpp.baseUrl).port),
    dataDir: config.paths.dataDir,
  });

  await manager.start();
  return manager;
}

export async function writeTimestampedReportArtifacts(
  config: Pick<ConfigSnapshot, "paths">,
  reportPrefix: string,
  createdAt: string,
  markdown: string,
  report: unknown,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const reportsDir = path.resolve(config.paths.dataDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  const stamp = createdAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
  const basePath = path.resolve(reportsDir, `${reportPrefix}-${stamp}`);
  const markdownPath = `${basePath}.md`;
  const jsonPath = `${basePath}.json`;

  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  return { markdownPath, jsonPath };
}
