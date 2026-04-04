import path from "node:path";

import type { Logger } from "pino";

import { createAiProvider as defaultCreateAiProvider } from "../ai/provider-registry.js";
import { readPromptPack } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation as defaultRunScenarioEvaluation } from "../eval/scenario-runner.js";
import { applyNonLiveScriptOverrides, ensureLlamaServer, writeTimestampedReportArtifacts } from "../scripts/script-support.js";
import type { AiProviderKind, ConfigSnapshot } from "../types.js";
import {
  buildPilotApprovalReport,
  combineScenarioResults,
  formatPilotApprovalMarkdown,
  type PilotApprovalReport,
} from "./pilot-approval.js";

interface RunPilotApprovalOptions {
  config: ConfigSnapshot;
  logger: Logger;
  promptPack: string;
  provider?: AiProviderKind;
  model?: string;
  createAiProvider?: typeof defaultCreateAiProvider;
  runScenarioEvaluation?: typeof defaultRunScenarioEvaluation;
  writeArtifacts?: boolean;
}

async function buildPackConfig(
  baseConfig: ConfigSnapshot,
  promptPack: string,
  provider?: AiProviderKind,
  model?: string,
): Promise<ConfigSnapshot> {
  const prompts = await readPromptPack(baseConfig.paths.promptsDir, promptPack);
  const config = applyNonLiveScriptOverrides(structuredClone(baseConfig), {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  config.prompts = prompts;
  config.ai.promptPack = promptPack;
  return config;
}

export async function runPilotApproval(options: RunPilotApprovalOptions): Promise<{
  report: PilotApprovalReport;
  markdown: string;
  artifacts: { markdownPath: string; jsonPath: string } | null;
}> {
  const config = await buildPackConfig(options.config, options.promptPack, options.provider, options.model);
  const llamaServer = await ensureLlamaServer(config, options.logger);

  try {
    const aiProvider = await (options.createAiProvider ?? defaultCreateAiProvider)(config, options.logger);
    const loadedScenarios = await loadScenarios(path.resolve(config.paths.rootDir, "evals/scenarios"));
    const scenarioRunner = options.runScenarioEvaluation ?? defaultRunScenarioEvaluation;
    const scenarioResults = [];

    for (const loaded of loadedScenarios) {
      scenarioResults.push(
        await scenarioRunner(loaded.scenario, {
          config,
          logger: options.logger,
          aiProvider,
        }),
      );
    }

    const report = buildPilotApprovalReport({
      config,
      scenarioResults: combineScenarioResults(loadedScenarios, scenarioResults),
    });
    const markdown = formatPilotApprovalMarkdown(report);
    const artifacts = options.writeArtifacts
      ? await writeTimestampedReportArtifacts(
          config,
          "pilot-approval",
          report.createdAt,
          markdown,
          report,
        )
      : null;

    return { report, markdown, artifacts };
  } finally {
    await llamaServer?.stop();
  }
}
