import { loadConfig } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation, type ScenarioEvaluationResult } from "../eval/scenario-runner.js";
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

interface CategoryCounters {
  timeoutsIssued: number;
  correctTimeouts: number;
  wrongfulTimeouts: number;
  timeoutsExpected: number;
  timeoutsCaught: number;
  abstains: number;
  warns: number;
}

interface CategoryMetrics extends CategoryCounters {
  category: string;
  precision: number | null;
  recall: number | null;
}

function emptyCounters(): CategoryCounters {
  return {
    timeoutsIssued: 0, correctTimeouts: 0, wrongfulTimeouts: 0,
    timeoutsExpected: 0, timeoutsCaught: 0, abstains: 0, warns: 0,
  };
}

function formatPct(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(0).padStart(4)}%`;
}

function formatMetricsRow(label: string, c: CategoryCounters, precision: number | null, recall: number | null): string {
  const col = (n: number, w: number) => String(n).padStart(w);
  return [
    `  ${label.padEnd(25)}`,
    col(c.timeoutsIssued, 8), col(c.correctTimeouts, 7), col(c.wrongfulTimeouts, 8),
    col(c.timeoutsExpected, 8), col(c.timeoutsCaught, 6),
    col(c.warns, 5), col(c.abstains, 8),
    formatPct(precision).padStart(9), formatPct(recall).padStart(6),
  ].join(" | ");
}

function computeCategoryMetrics(results: ScenarioEvaluationResult[]): CategoryMetrics[] {
  const categories = new Map<string, CategoryCounters>();

  for (const result of results) {
    for (const step of result.steps) {
      const cat = step.moderationCategory ?? "none";
      if (!categories.has(cat)) categories.set(cat, emptyCounters());
      const entry = categories.get(cat)!;

      const hasTimeout = step.actualActionKinds.includes("timeout");
      const hasWarn = step.actualActionKinds.includes("warn") && !hasTimeout;
      const isAbstain = step.actualOutcome === "abstain" || step.actualOutcome === "no_action";
      const wrongfulTimeout = step.issues.some((i) => i.kind === "wrongful_timeout");

      if (hasTimeout) {
        entry.timeoutsIssued += 1;
        if (wrongfulTimeout) {
          entry.wrongfulTimeouts += 1;
        } else {
          entry.correctTimeouts += 1;
        }
      }
      if (hasWarn) entry.warns += 1;
      if (isAbstain) entry.abstains += 1;
      if (step.timeoutRequired) {
        entry.timeoutsExpected += 1;
        if (hasTimeout && !wrongfulTimeout) {
          entry.timeoutsCaught += 1;
        }
      }
    }
  }

  return [...categories.entries()]
    .map(([category, data]) => ({
      category,
      ...data,
      precision: data.timeoutsIssued === 0 ? null : data.correctTimeouts / data.timeoutsIssued,
      recall: data.timeoutsExpected === 0 ? null : data.timeoutsCaught / data.timeoutsExpected,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function printCategoryMetrics(metrics: CategoryMetrics[]): void {
  const relevant = metrics.filter(
    (m) => m.timeoutsIssued > 0 || m.timeoutsExpected > 0 || m.warns > 0,
  );

  if (relevant.length === 0) return;

  const header = [
    `  ${"Category".padEnd(25)}`, "Timeouts".padStart(8), "Correct".padStart(7),
    "Wrongful".padStart(8), "Expected".padStart(8), "Caught".padStart(6),
    "Warns".padStart(5), "Abstains".padStart(8), "Precision".padStart(9), "Recall".padStart(6),
  ].join(" | ");
  const divider = header.replace(/[^|]/g, "-");

  console.log("\nCategory Metrics:");
  console.log(header);
  console.log(divider);

  for (const m of relevant) {
    console.log(formatMetricsRow(m.category, m, m.precision, m.recall));
  }

  const totals = relevant.reduce((acc, m) => {
    for (const key of Object.keys(acc) as (keyof CategoryCounters)[]) {
      acc[key] += m[key];
    }
    return acc;
  }, emptyCounters());
  const totalPrecision = totals.timeoutsIssued === 0 ? null : totals.correctTimeouts / totals.timeoutsIssued;
  const totalRecall = totals.timeoutsExpected === 0 ? null : totals.timeoutsCaught / totals.timeoutsExpected;
  console.log(formatMetricsRow("TOTAL", totals, totalPrecision, totalRecall));
}

function printConfidenceCalibration(results: ScenarioEvaluationResult[]): void {
  const bucketThresholds = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
  const buckets = bucketThresholds.map((low) => ({
    label: `${low.toFixed(2)}-${(low + 0.1).toFixed(2)}`,
    low,
    high: low + 0.1,
    total: 0,
    correct: 0,
  }));

  for (const result of results) {
    for (const step of result.steps) {
      if (step.confidence === null || step.confidence < 0.5) continue;
      const bucket = [...buckets].reverse().find((b) => step.confidence! >= b.low);
      if (!bucket) continue;
      bucket.total += 1;
      if (step.passed) bucket.correct += 1;
    }
  }

  const relevant = buckets.filter((b) => b.total > 0);
  if (relevant.length === 0) return;

  console.log("\nConfidence Calibration:");
  console.log("  Bucket     | Count | Correct | Accuracy");
  console.log("  -----------|-------|---------|--------");
  for (const b of relevant) {
    const accuracy = `${((b.correct / b.total) * 100).toFixed(0)}%`;
    console.log(
      `  ${b.label.padEnd(11)}| ${String(b.total).padStart(5)} | ${String(b.correct).padStart(7)} | ${accuracy.padStart(7)}`,
    );
  }
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
  printCategoryMetrics(computeCategoryMetrics(results));
  printConfidenceCalibration(results);

  const failedCount = results.filter((result) => !result.passed).length;
  console.log(
    `\nSummary: ${results.length - failedCount}/${results.length} scenarios passed for pack=${config.prompts.packName} model=${getActiveModel(
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
