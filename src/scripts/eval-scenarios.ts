import { loadConfig } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation } from "../eval/scenario-runner.js";
import { applyNonLiveScriptOverrides, ensureLlamaServer, getActiveModel } from "./script-support.js";
import { createLogger } from "../storage/logger.js";
import type { AiProviderKind } from "../types.js";

interface ScenarioEvalCliOptions {
  suite?: string;
  scenarioId?: string;
  provider?: AiProviderKind;
  model?: string;
  promptPack?: string;
}

function printUsage(): void {
  console.log(
    "Usage: npm run eval:scenarios -- [--suite <name>] [--scenario <id>] [--provider ollama|openai|llama-cpp] [--model <name>] [--prompt-pack <name>]",
  );
}

function parseArgs(argv: string[]): ScenarioEvalCliOptions {
  const options: ScenarioEvalCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--suite": {
        const value = argv[index + 1];

        if (!value) {
          throw new Error("--suite requires a value");
        }

        options.suite = value;
        index += 1;
        break;
      }
      case "--scenario": {
        const value = argv[index + 1];

        if (!value) {
          throw new Error("--scenario requires a value");
        }

        options.scenarioId = value;
        index += 1;
        break;
      }
      case "--provider": {
        const value = argv[index + 1];

        if (value !== "ollama" && value !== "openai" && value !== "llama-cpp") {
          throw new Error("--provider must be ollama, openai, or llama-cpp");
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
      case "--prompt-pack": {
        const value = argv[index + 1];

        if (!value) {
          throw new Error("--prompt-pack requires a value");
        }

        options.promptPack = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printScenarioReport(results: Awaited<ReturnType<typeof runScenarioEvaluation>>[]): void {
  for (const result of results) {
    const actionKinds = result.actualActionKinds.length > 0 ? result.actualActionKinds.join(",") : "none";
    const actionStatuses =
      result.actualActionStatuses.length > 0 ? result.actualActionStatuses.join(",") : "none";
    const replyExcerpt = result.replyExcerpt ? ` reply="${result.replyExcerpt}"` : "";
    const providerFailure = result.providerFailureKind
      ? ` provider-failure=${result.providerFailureKind}${result.providerErrorType ? `:${result.providerErrorType}` : ""}`
      : "";

    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${result.scenarioId} pack=${result.promptPack} provider=${result.provider} model=${result.model} mode=${result.selectedMode} outcome=${result.actualOutcome} actions=${actionKinds} statuses=${actionStatuses} chars=${result.promptChars}${providerFailure}${replyExcerpt}`,
    );

    if (!result.passed) {
      for (const failure of result.failures) {
        console.log(`  - ${failure}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loadedConfig = await loadConfig(process.cwd(), {
    ...(options.promptPack ? { promptPack: options.promptPack } : {}),
  });
  const config = applyNonLiveScriptOverrides(loadedConfig, options);
  const logger = createLogger(config.runtime.logLevel, `${config.app.name}-scenario-eval`);
  const llamaServer = await ensureLlamaServer(config, logger);
  try {
  const scenarios = await loadScenarios(`${config.paths.rootDir}/evals/scenarios`, {
    ...(options.suite ? { suite: options.suite } : {}),
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
  });

  if (scenarios.length === 0) {
    throw new Error("No scenarios matched the requested filters.");
  }

  const results = [];

  for (const loaded of scenarios) {
    const result = await runScenarioEvaluation(loaded.scenario, {
      config,
      logger,
    });

    results.push(result);
  }

  printScenarioReport(results);

  const failedCount = results.filter((result) => !result.passed).length;
  console.log(
    `Summary: ${results.length - failedCount}/${results.length} scenarios passed for pack=${config.prompts.packName} model=${getActiveModel(
      config,
    )}`,
  );

  if (failedCount > 0) {
    process.exitCode = 1;
  }
  } finally {
    await llamaServer?.stop();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
