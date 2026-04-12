import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import { getConfiguredModel } from "../ai/provider-config.js";
import { LlamaServerManager } from "../admin/llama-server-manager.js";
import type { AiProviderKind, ConfigSnapshot } from "../types.js";

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
  nextConfig.runtime.dryRun = true;
  nextConfig.actions.allowLiveChatMessages = false;
  nextConfig.actions.allowLiveModeration = false;

  if (options.model) {
    if (provider === "ollama") {
      nextConfig.ai.ollama.model = options.model;
    } else if (provider === "llama-cpp" && nextConfig.ai.llamaCpp) {
      nextConfig.ai.llamaCpp.model = options.model;
    } else if (provider === "azure" && nextConfig.ai.azure) {
      nextConfig.ai.azure.model = options.model;
    } else {
      nextConfig.ai.openai.model = options.model;
    }
  }

  return nextConfig;
}

export function getActiveModel(config: Pick<ConfigSnapshot, "ai">): string {
  return getConfiguredModel(config);
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
