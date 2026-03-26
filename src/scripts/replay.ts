import { loadConfig } from "../config/load-config.js";
import { runReplayEvaluation } from "../replay/replay-runner.js";
import { applyNonLiveScriptOverrides, getActiveModel } from "./script-support.js";
import { BotDatabase } from "../storage/database.js";
import { createLogger } from "../storage/logger.js";
import type { AiProviderKind } from "../types.js";

interface ReplayCliOptions {
  limit?: number;
  provider?: AiProviderKind;
  model?: string;
  promptPack?: string;
}

function printUsage(): void {
  console.log(
    "Usage: npm run replay -- [--limit <n>] [--provider ollama|openai] [--model <name>] [--prompt-pack <name>]",
  );
}

function parseArgs(argv: string[]): ReplayCliOptions {
  const options: ReplayCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--limit": {
        const value = argv[index + 1];

        if (!value) {
          throw new Error("--limit requires a numeric value");
        }

        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("--limit must be a positive integer");
        }

        options.limit = parsed;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loadedConfig = await loadConfig(process.cwd(), {
    ...(options.promptPack ? { promptPack: options.promptPack } : {}),
  });
  const config = applyNonLiveScriptOverrides(loadedConfig, options);
  const logger = createLogger(config.runtime.logLevel, `${config.app.name}-replay`);
  const database = new BotDatabase(config.storage.sqlitePath);
  const snapshots = database.listMessageSnapshots(options.limit);

  if (snapshots.length === 0) {
    logger.warn("no message snapshots available for replay; run the live bot first");
    database.close();
    return;
  }

  logger.info(
    {
      messageCount: snapshots.length,
      provider: config.ai.provider,
      model: getActiveModel(config),
      promptPack: config.prompts.packName,
    },
    "starting replay run",
  );

  const summary = await runReplayEvaluation({
    config,
    logger,
    database,
    snapshots,
  });

  logger.info(
    {
      runId: summary.runId,
      messageCount: snapshots.length,
      processed: summary.processed,
      ruleActions: summary.ruleActions,
      aiActions: summary.aiActions,
      aiAbstains: summary.aiAbstains,
      sayActions: summary.sayActions,
      warnActions: summary.warnActions,
      timeoutActions: summary.timeoutActions,
      providerFailures: summary.providerFailures.length,
      timeoutCandidates: summary.timeoutCandidates.length,
    },
    "completed replay run",
  );
  database.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
