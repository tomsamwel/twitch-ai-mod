import { pathToFileURL } from "node:url";

import { loadConfig } from "../config/load-config.js";
import { runCompareReport } from "../eval/compare-report.js";
import { createLogger } from "../storage/logger.js";
import type { AiProviderKind } from "../types.js";

export { comparePackMetrics, formatCompareMarkdown } from "../eval/compare-report.js";

interface EvalCompareCliOptions {
  baseline: string;
  candidate: string;
  suite?: string;
  provider?: AiProviderKind;
  model?: string;
}

function printUsage(): void {
  console.log(
    "Usage: npm run eval:compare -- --baseline <pack> --candidate <pack> [--suite <name>] [--provider ollama|openai|llama-cpp] [--model <name>]",
  );
}

function parseArgs(argv: string[]): EvalCompareCliOptions {
  const options = {} as Partial<EvalCompareCliOptions>;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--baseline":
        if (!argv[index + 1]) {
          throw new Error("--baseline requires a value");
        }
        options.baseline = argv[index + 1]!;
        index += 1;
        break;
      case "--candidate":
        if (!argv[index + 1]) {
          throw new Error("--candidate requires a value");
        }
        options.candidate = argv[index + 1]!;
        index += 1;
        break;
      case "--suite":
        if (!argv[index + 1]) {
          throw new Error("--suite requires a value");
        }
        options.suite = argv[index + 1]!;
        index += 1;
        break;
      case "--provider": {
        const value = argv[index + 1];
        if (value !== "ollama" && value !== "openai" && value !== "llama-cpp") {
          throw new Error("--provider must be ollama, openai, or llama-cpp");
        }
        options.provider = value;
        index += 1;
        break;
      }
      case "--model":
        if (!argv[index + 1]) {
          throw new Error("--model requires a value");
        }
        options.model = argv[index + 1]!;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.baseline || !options.candidate) {
    throw new Error("--baseline and --candidate are required");
  }

  return options as EvalCompareCliOptions;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const logger = createLogger(config.runtime.logLevel, `${config.app.name}-eval-compare`);
  const { report, artifacts } = await runCompareReport({
    config,
    logger,
    baselinePack: options.baseline,
    candidatePack: options.candidate,
    ...(options.suite ? { suite: options.suite } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    writeArtifacts: true,
  });

  console.log(
    `Compare complete: baseline=${options.baseline}(${report.totals.baselinePassed}/${report.totals.scenarios}) candidate=${options.candidate}(${report.totals.candidatePassed}/${report.totals.scenarios})`,
  );
  console.log(`Markdown report: ${artifacts?.markdownPath}`);
  console.log(`JSON report: ${artifacts?.jsonPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
