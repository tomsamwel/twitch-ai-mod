import path from "node:path";

import { getConfiguredProviderInfo } from "../ai/provider-config.js";
import { createAiProvider } from "../ai/provider-registry.js";
import { loadPromptPackManifest } from "../ai/prompt-pack-manifest.js";
import { loadConfig } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation, type ScenarioEvaluationResult } from "../eval/scenario-runner.js";
import { applyNonLiveScriptOverrides, writeTimestampedReportArtifacts } from "./script-support.js";
import { createLogger } from "../storage/logger.js";
import type { AiProviderKind } from "../types.js";

interface EvalCompareCliOptions {
  baseline: string;
  candidate: string;
  suite?: string;
  provider?: AiProviderKind;
  model?: string;
}

interface CompareScenarioDelta {
  suite: string;
  scenarioId: string;
  description: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineOutcome: string;
  candidateOutcome: string;
  baselineActions: string[];
  candidateActions: string[];
  baselineReply: string | null;
  candidateReply: string | null;
  baselineProviderFailure: string | null;
  candidateProviderFailure: string | null;
}

interface CompareReport {
  createdAt: string;
  provider: AiProviderKind;
  model: string;
  baselinePack: string;
  candidatePack: string;
  baselineManifest: Awaited<ReturnType<typeof loadPromptPackManifest>>;
  candidateManifest: Awaited<ReturnType<typeof loadPromptPackManifest>>;
  totals: {
    scenarios: number;
    baselinePassed: number;
    candidatePassed: number;
  };
  promptSizeHints: {
    baselineAverageChars: number;
    candidateAverageChars: number;
  };
  providerFailureCounts: {
    baseline: number;
    candidate: number;
  };
  suiteSummaries: Array<{
    suite: string;
    baselinePassed: number;
    candidatePassed: number;
    total: number;
  }>;
  deltas: CompareScenarioDelta[];
}

function printUsage(): void {
  console.log(
    "Usage: npm run eval:compare -- --baseline <pack> --candidate <pack> [--suite <name>] [--provider ollama|openai] [--model <name>]",
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
        if (value !== "ollama" && value !== "openai") {
          throw new Error("--provider must be either ollama or openai");
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

function formatCompareMarkdown(report: CompareReport): string {
  const lines = [
    "# Eval Compare Report",
    "",
    `- Generated at: ${report.createdAt}`,
    `- Provider/model: ${report.provider} / ${report.model}`,
    `- Baseline pack: ${report.baselinePack} (${report.baselineManifest.label})`,
    `- Candidate pack: ${report.candidatePack} (${report.candidateManifest.label})`,
    "",
    "## Totals",
    "",
    `- Scenarios: ${report.totals.scenarios}`,
    `- Baseline passed: ${report.totals.baselinePassed}`,
    `- Candidate passed: ${report.totals.candidatePassed}`,
    `- Prompt size avg chars: baseline ${report.promptSizeHints.baselineAverageChars}, candidate ${report.promptSizeHints.candidateAverageChars}`,
    `- Provider failures: baseline ${report.providerFailureCounts.baseline}, candidate ${report.providerFailureCounts.candidate}`,
    "",
    "## Suite Summary",
    "",
    "| Suite | Baseline | Candidate | Total |",
    "| --- | ---: | ---: | ---: |",
    ...report.suiteSummaries.map(
      (summary) =>
        `| ${summary.suite} | ${summary.baselinePassed}/${summary.total} | ${summary.candidatePassed}/${summary.total} | ${summary.total} |`,
    ),
    "",
    "## Scenario Deltas",
    "",
  ];

  for (const delta of report.deltas.filter(
    (entry) =>
      entry.baselinePassed !== entry.candidatePassed ||
      entry.baselineOutcome !== entry.candidateOutcome ||
      entry.baselineProviderFailure !== entry.candidateProviderFailure,
  )) {
    lines.push(
      `- ${delta.suite}/${delta.scenarioId}: baseline=${delta.baselinePassed ? "PASS" : "FAIL"}(${delta.baselineOutcome}/${delta.baselineActions.join(",") || "none"}) candidate=${delta.candidatePassed ? "PASS" : "FAIL"}(${delta.candidateOutcome}/${delta.candidateActions.join(",") || "none"})`,
    );
    if (delta.baselineReply || delta.candidateReply) {
      lines.push(`  baselineReply="${delta.baselineReply ?? ""}"`);
      lines.push(`  candidateReply="${delta.candidateReply ?? ""}"`);
    }
    if (delta.baselineProviderFailure || delta.candidateProviderFailure) {
      lines.push(
        `  providerFailures=baseline:${delta.baselineProviderFailure ?? "none"} candidate:${delta.candidateProviderFailure ?? "none"}`,
      );
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [baselineLoadedConfig, candidateLoadedConfig] = await Promise.all([
    loadConfig(process.cwd(), { promptPack: options.baseline }),
    loadConfig(process.cwd(), { promptPack: options.candidate }),
  ]);
  const baselineConfig = applyNonLiveScriptOverrides(baselineLoadedConfig, options);
  const candidateConfig = applyNonLiveScriptOverrides(candidateLoadedConfig, options);
  const logger = createLogger(baselineConfig.runtime.logLevel, `${baselineConfig.app.name}-eval-compare`);
  const aiProvider = await createAiProvider(baselineConfig, logger);
  const loadedScenarios = await loadScenarios(path.resolve(baselineConfig.paths.rootDir, "evals/scenarios"), {
    ...(options.suite ? { suite: options.suite } : {}),
  });

  if (loadedScenarios.length === 0) {
    throw new Error("No scenarios matched the requested filters.");
  }

  const baselineResults: ScenarioEvaluationResult[] = [];
  const candidateResults: ScenarioEvaluationResult[] = [];

  for (const loaded of loadedScenarios) {
    baselineResults.push(
      await runScenarioEvaluation(loaded.scenario, {
        config: baselineConfig,
        logger,
        aiProvider,
      }),
    );
    candidateResults.push(
      await runScenarioEvaluation(loaded.scenario, {
        config: candidateConfig,
        logger,
        aiProvider,
      }),
    );
  }

  const deltas = loadedScenarios.map((loaded, index) => ({
    suite: loaded.suite,
    scenarioId: loaded.scenario.id,
    description: loaded.scenario.description,
    baselinePassed: baselineResults[index]!.passed,
    candidatePassed: candidateResults[index]!.passed,
    baselineOutcome: baselineResults[index]!.actualOutcome,
    candidateOutcome: candidateResults[index]!.actualOutcome,
    baselineActions: baselineResults[index]!.actualActionKinds,
    candidateActions: candidateResults[index]!.actualActionKinds,
    baselineReply: baselineResults[index]!.replyExcerpt,
    candidateReply: candidateResults[index]!.replyExcerpt,
    baselineProviderFailure: baselineResults[index]!.providerFailureKind,
    candidateProviderFailure: candidateResults[index]!.providerFailureKind,
  }));
  const suiteMap = new Map<string, { baselinePassed: number; candidatePassed: number; total: number }>();

  for (const delta of deltas) {
    const current = suiteMap.get(delta.suite) ?? { baselinePassed: 0, candidatePassed: 0, total: 0 };
    current.total += 1;
    current.baselinePassed += delta.baselinePassed ? 1 : 0;
    current.candidatePassed += delta.candidatePassed ? 1 : 0;
    suiteMap.set(delta.suite, current);
  }

  const providerInfo = getConfiguredProviderInfo(baselineConfig);
  const report: CompareReport = {
    createdAt: new Date().toISOString(),
    provider: providerInfo.provider,
    model: providerInfo.model,
    baselinePack: options.baseline,
    candidatePack: options.candidate,
    baselineManifest: await loadPromptPackManifest(baselineConfig, options.baseline),
    candidateManifest: await loadPromptPackManifest(candidateConfig, options.candidate),
    totals: {
      scenarios: deltas.length,
      baselinePassed: baselineResults.filter((result) => result.passed).length,
      candidatePassed: candidateResults.filter((result) => result.passed).length,
    },
    promptSizeHints: {
      baselineAverageChars: Math.round(
        baselineResults.reduce((sum, result) => sum + result.promptChars, 0) / baselineResults.length,
      ),
      candidateAverageChars: Math.round(
        candidateResults.reduce((sum, result) => sum + result.promptChars, 0) / candidateResults.length,
      ),
    },
    providerFailureCounts: {
      baseline: baselineResults.filter((result) => result.providerFailureKind).length,
      candidate: candidateResults.filter((result) => result.providerFailureKind).length,
    },
    suiteSummaries: [...suiteMap.entries()]
      .map(([suite, summary]) => ({
        suite,
        ...summary,
      }))
      .sort((left, right) => left.suite.localeCompare(right.suite)),
    deltas,
  };

  const artifacts = await writeTimestampedReportArtifacts(
    baselineConfig,
    "eval-compare",
    report.createdAt,
    formatCompareMarkdown(report),
    report,
  );

  console.log(
    `Compare complete: baseline=${options.baseline}(${report.totals.baselinePassed}/${report.totals.scenarios}) candidate=${options.candidate}(${report.totals.candidatePassed}/${report.totals.scenarios})`,
  );
  console.log(`Markdown report: ${artifacts.markdownPath}`);
  console.log(`JSON report: ${artifacts.jsonPath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
