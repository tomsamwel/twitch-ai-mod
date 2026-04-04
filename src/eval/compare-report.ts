import path from "node:path";

import type { Logger } from "pino";

import { loadPromptPackManifest } from "../ai/prompt-pack-manifest.js";
import { getConfiguredProviderInfo } from "../ai/provider-config.js";
import { createAiProvider as defaultCreateAiProvider } from "../ai/provider-registry.js";
import { readPromptPack } from "../config/load-config.js";
import { loadScenarios } from "../eval/load-scenarios.js";
import { runScenarioEvaluation as defaultRunScenarioEvaluation, type ScenarioEvaluationResult } from "../eval/scenario-runner.js";
import { applyNonLiveScriptOverrides, ensureLlamaServer, writeTimestampedReportArtifacts } from "../scripts/script-support.js";
import type { AiProviderKind, ConfigSnapshot } from "../types.js";

export interface CompareScenarioDelta {
  suite: string;
  scenarioId: string;
  description: string;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineBlockingIssues: number;
  candidateBlockingIssues: number;
  baselineAdvisoryIssues: number;
  candidateAdvisoryIssues: number;
  baselineWrongfulTimeouts: number;
  candidateWrongfulTimeouts: number;
  baselineBlockingMissedTimeouts: number;
  candidateBlockingMissedTimeouts: number;
  baselineOutcome: string;
  candidateOutcome: string;
  baselineActions: string[];
  candidateActions: string[];
  baselineReply: string | null;
  candidateReply: string | null;
  baselineProviderFailure: string | null;
  candidateProviderFailure: string | null;
}

export interface ComparePackMetrics {
  passed: number;
  wrongfulTimeouts: number;
  blockingMissedTimeouts: number;
  providerFailures: number;
  advisoryIssues: number;
  timeoutPrecision: number | null;
}

export interface CompareReport {
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
  ranking: {
    winner: "baseline" | "candidate" | "tie";
    baseline: ComparePackMetrics;
    candidate: ComparePackMetrics;
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

interface RunCompareReportOptions {
  config: ConfigSnapshot;
  logger: Logger;
  baselinePack: string;
  candidatePack: string;
  suite?: string;
  provider?: AiProviderKind;
  model?: string;
  createAiProvider?: typeof defaultCreateAiProvider;
  runScenarioEvaluation?: typeof defaultRunScenarioEvaluation;
  writeArtifacts?: boolean;
}

function summarizePackMetrics(results: ScenarioEvaluationResult[]): ComparePackMetrics {
  const timeoutActionsObserved = results.reduce(
    (count, result) => count + result.steps.filter((step) => step.actualActionKinds.includes("timeout")).length,
    0,
  );
  const wrongfulTimeouts = results.reduce(
    (count, result) => count + result.issues.filter((issue) => issue.kind === "wrongful_timeout").length,
    0,
  );

  return {
    passed: results.filter((result) => result.passed).length,
    wrongfulTimeouts,
    blockingMissedTimeouts: results.reduce(
      (count, result) =>
        count +
        result.issues.filter(
          (issue) => issue.kind === "missed_required_timeout" && issue.severity === "blocking",
        ).length,
      0,
    ),
    providerFailures: results.reduce(
      (count, result) => count + result.issues.filter((issue) => issue.kind === "provider_failure").length,
      0,
    ),
    advisoryIssues: results.reduce((count, result) => count + result.advisoryIssueCount, 0),
    timeoutPrecision:
      timeoutActionsObserved === 0 ? null : Math.max(0, timeoutActionsObserved - wrongfulTimeouts) / timeoutActionsObserved,
  };
}

export function comparePackMetrics(left: ComparePackMetrics, right: ComparePackMetrics): number {
  const leftKey = [left.wrongfulTimeouts, left.blockingMissedTimeouts, left.providerFailures, left.advisoryIssues];
  const rightKey = [right.wrongfulTimeouts, right.blockingMissedTimeouts, right.providerFailures, right.advisoryIssues];

  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return leftKey[index]! < rightKey[index]! ? -1 : 1;
    }
  }

  return 0;
}

export function formatCompareMarkdown(report: CompareReport): string {
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
    `- Precision-first winner: ${report.ranking.winner}`,
    `- Wrongful timeouts: baseline ${report.ranking.baseline.wrongfulTimeouts}, candidate ${report.ranking.candidate.wrongfulTimeouts}`,
    `- Blocking missed timeouts: baseline ${report.ranking.baseline.blockingMissedTimeouts}, candidate ${report.ranking.candidate.blockingMissedTimeouts}`,
    `- Provider failures: baseline ${report.ranking.baseline.providerFailures}, candidate ${report.ranking.candidate.providerFailures}`,
    `- Advisory issues: baseline ${report.ranking.baseline.advisoryIssues}, candidate ${report.ranking.candidate.advisoryIssues}`,
    `- Timeout precision: baseline ${
      report.ranking.baseline.timeoutPrecision === null
        ? "n/a"
        : `${(report.ranking.baseline.timeoutPrecision * 100).toFixed(1)}%`
    }, candidate ${
      report.ranking.candidate.timeoutPrecision === null
        ? "n/a"
        : `${(report.ranking.candidate.timeoutPrecision * 100).toFixed(1)}%`
    }`,
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
      entry.baselineBlockingIssues !== entry.candidateBlockingIssues ||
      entry.baselineAdvisoryIssues !== entry.candidateAdvisoryIssues ||
      entry.baselineWrongfulTimeouts !== entry.candidateWrongfulTimeouts ||
      entry.baselineBlockingMissedTimeouts !== entry.candidateBlockingMissedTimeouts ||
      entry.baselinePassed !== entry.candidatePassed ||
      entry.baselineOutcome !== entry.candidateOutcome ||
      entry.baselineProviderFailure !== entry.candidateProviderFailure,
  )) {
    lines.push(
      `- ${delta.suite}/${delta.scenarioId}: baseline=block:${delta.baselineBlockingIssues} adv:${delta.baselineAdvisoryIssues} wrongful:${delta.baselineWrongfulTimeouts} missed:${delta.baselineBlockingMissedTimeouts} ${delta.baselinePassed ? "PASS" : "FAIL"}(${delta.baselineOutcome}/${delta.baselineActions.join(",") || "none"}) candidate=block:${delta.candidateBlockingIssues} adv:${delta.candidateAdvisoryIssues} wrongful:${delta.candidateWrongfulTimeouts} missed:${delta.candidateBlockingMissedTimeouts} ${delta.candidatePassed ? "PASS" : "FAIL"}(${delta.candidateOutcome}/${delta.candidateActions.join(",") || "none"})`,
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

async function buildPackConfig(
  baseConfig: ConfigSnapshot,
  packName: string,
  provider?: AiProviderKind,
  model?: string,
): Promise<ConfigSnapshot> {
  const prompts = await readPromptPack(baseConfig.paths.promptsDir, packName);
  const config = applyNonLiveScriptOverrides(structuredClone(baseConfig), {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  config.prompts = prompts;
  config.ai.promptPack = packName;
  return config;
}

export async function runCompareReport(options: RunCompareReportOptions): Promise<{
  report: CompareReport;
  markdown: string;
  artifacts: { markdownPath: string; jsonPath: string } | null;
}> {
  const [baselineConfig, candidateConfig] = await Promise.all([
    buildPackConfig(options.config, options.baselinePack, options.provider, options.model),
    buildPackConfig(options.config, options.candidatePack, options.provider, options.model),
  ]);

  const llamaServer = await ensureLlamaServer(baselineConfig, options.logger);
  try {
    const aiProvider = await (options.createAiProvider ?? defaultCreateAiProvider)(baselineConfig, options.logger);
    const loadedScenarios = await loadScenarios(path.resolve(baselineConfig.paths.rootDir, "evals/scenarios"), {
      ...(options.suite ? { suite: options.suite } : {}),
    });

    if (loadedScenarios.length === 0) {
      throw new Error("No scenarios matched the requested filters.");
    }

    const scenarioRunner = options.runScenarioEvaluation ?? defaultRunScenarioEvaluation;
    const baselineResults: ScenarioEvaluationResult[] = [];
    const candidateResults: ScenarioEvaluationResult[] = [];

    for (const loaded of loadedScenarios) {
      baselineResults.push(
        await scenarioRunner(loaded.scenario, {
          config: baselineConfig,
          logger: options.logger,
          aiProvider,
        }),
      );
      candidateResults.push(
        await scenarioRunner(loaded.scenario, {
          config: candidateConfig,
          logger: options.logger,
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
      baselineBlockingIssues: baselineResults[index]!.blockingIssueCount,
      candidateBlockingIssues: candidateResults[index]!.blockingIssueCount,
      baselineAdvisoryIssues: baselineResults[index]!.advisoryIssueCount,
      candidateAdvisoryIssues: candidateResults[index]!.advisoryIssueCount,
      baselineWrongfulTimeouts: baselineResults[index]!.issues.filter((issue) => issue.kind === "wrongful_timeout").length,
      candidateWrongfulTimeouts: candidateResults[index]!.issues.filter((issue) => issue.kind === "wrongful_timeout").length,
      baselineBlockingMissedTimeouts: baselineResults[index]!.issues.filter(
        (issue) => issue.kind === "missed_required_timeout" && issue.severity === "blocking",
      ).length,
      candidateBlockingMissedTimeouts: candidateResults[index]!.issues.filter(
        (issue) => issue.kind === "missed_required_timeout" && issue.severity === "blocking",
      ).length,
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
    const baselineMetrics = summarizePackMetrics(baselineResults);
    const candidateMetrics = summarizePackMetrics(candidateResults);
    const rankingComparison = comparePackMetrics(baselineMetrics, candidateMetrics);
    const report: CompareReport = {
      createdAt: new Date().toISOString(),
      provider: providerInfo.provider,
      model: providerInfo.model,
      baselinePack: options.baselinePack,
      candidatePack: options.candidatePack,
      baselineManifest: await loadPromptPackManifest(baselineConfig, options.baselinePack),
      candidateManifest: await loadPromptPackManifest(candidateConfig, options.candidatePack),
      totals: {
        scenarios: deltas.length,
        baselinePassed: baselineResults.filter((result) => result.passed).length,
        candidatePassed: candidateResults.filter((result) => result.passed).length,
      },
      ranking: {
        winner: rankingComparison === 0 ? "tie" : rankingComparison < 0 ? "baseline" : "candidate",
        baseline: baselineMetrics,
        candidate: candidateMetrics,
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

    const markdown = formatCompareMarkdown(report);
    const artifacts = options.writeArtifacts
      ? await writeTimestampedReportArtifacts(
          baselineConfig,
          "eval-compare",
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
