import path from "node:path";

import { createAiProvider } from "../ai/provider-registry.js";
import {
  buildPilotApprovalReport,
  combineScenarioResults,
  formatPilotApprovalMarkdown,
} from "../approval/pilot-approval.js";
import { loadConfig } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation } from "../eval/scenario-runner.js";
import { applyNonLiveScriptOverrides, getActiveModel, writeTimestampedReportArtifacts } from "./script-support.js";
import { createLogger } from "../storage/logger.js";
import type { AiProviderKind } from "../types.js";

interface ApprovePilotCliOptions {
  provider?: AiProviderKind;
  promptPack?: string;
  model?: string;
}

function printUsage(): void {
  console.log(
    "Usage: npm run approve:pilot -- [--provider ollama|openai] [--prompt-pack <name>] [--model <name>]",
  );
}

function parseArgs(argv: string[]): ApprovePilotCliOptions {
  const options: ApprovePilotCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--prompt-pack": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--prompt-pack requires a value");
        }
        options.promptPack = value;
        index += 1;
        break;
      }
      case "--provider": {
        const value = argv[index + 1];
        if (value !== "ollama" && value !== "openai") {
          throw new Error("--provider must be either ollama or openai");
        }
        options.provider = value;
        index += 1;
        break;
      }
      case "--model": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--model requires a value");
        }
        options.model = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loadedConfig = await loadConfig(process.cwd(), {
    ...(options.promptPack ? { promptPack: options.promptPack } : {}),
  });
  const config = applyNonLiveScriptOverrides(loadedConfig, options);

  const logger = createLogger(config.runtime.logLevel, `${config.app.name}-pilot-approval`);
  const aiProvider = await createAiProvider(config, logger);
  const loadedScenarios = await loadScenarios(path.resolve(config.paths.rootDir, "evals/scenarios"));
  const scenarioResults = [];

  for (const loaded of loadedScenarios) {
    const result = await runScenarioEvaluation(loaded.scenario, {
      config,
      logger,
      aiProvider,
    });
    scenarioResults.push(result);
  }

  const report = buildPilotApprovalReport({
    config,
    scenarioResults: combineScenarioResults(loadedScenarios, scenarioResults),
  });
  const artifacts = await writeTimestampedReportArtifacts(
    config,
    "pilot-approval",
    report.createdAt,
    formatPilotApprovalMarkdown(report),
    report,
  );

  console.log(
    `${report.approved ? "PASS" : "FAIL"} pilot approval pack=${report.promptPack} provider=${report.provider} model=${getActiveModel(
      config,
    )} passRate=${(report.scenarioTotals.passRate * 100).toFixed(1)}% providerFailures=${report.providerFailures.length}`,
  );
  console.log(`Markdown report: ${artifacts.markdownPath}`);
  console.log(`JSON report: ${artifacts.jsonPath}`);

  if (report.blockingReasons.length > 0) {
    for (const reason of report.blockingReasons) {
      console.log(`- ${reason}`);
    }
  }

  console.log("Next step: run review:inbox separately on curated-worthy real chat before enabling aimod ai-moderation on.");

  if (!report.approved) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
