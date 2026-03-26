import { getConfiguredProviderInfo } from "../ai/provider-config.js";
import type { LoadedScenario } from "../eval/load-scenarios.js";
import type {
  ScenarioEvaluationIssue,
  ScenarioEvaluationResult,
} from "../eval/scenario-runner.js";
import type { AiProviderKind, ConfigSnapshot } from "../types.js";

export interface PilotApprovalScenarioRecord {
  suite: string;
  path: string;
  hardSafetyBlocker: boolean;
  result: ScenarioEvaluationResult;
}

export interface PilotApprovalProviderFailure {
  phase: "scenario";
  suite?: string;
  scenarioId?: string;
  failureKind: string;
  errorType: string | null;
  reason: string;
}

export interface PilotApprovalReport {
  createdAt: string;
  provider: AiProviderKind;
  model: string;
  promptPack: string;
  approved: boolean;
  blockingReasons: string[];
  scenarioTotals: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    moderationTotal: number;
    moderationPassed: number;
    moderationPassRate: number;
    socialTotal: number;
    socialPassed: number;
    socialPassRate: number;
    hardSafetyBlockers: number;
    hardSafetyTimeoutRequirements: number;
    hardSafetyTimeoutSatisfied: number;
  };
  suiteSummaries: Array<{
    suite: string;
    kind: "moderation" | "social";
    total: number;
    passed: number;
    failed: number;
    blockingIssues: number;
    advisoryIssues: number;
    wrongfulTimeouts: number;
    blockingMissedTimeouts: number;
  }>;
  issueTotals: {
    blocking: number;
    advisory: number;
    wrongfulTimeouts: number;
    blockingMissedTimeouts: number;
    advisoryMissedTimeouts: number;
    providerFailures: number;
    otherExpectationMisses: number;
  };
  timeoutMetrics: {
    timeoutActionsObserved: number;
    correctTimeoutActions: number;
    precision: number | null;
    hardSafetyTimeoutRecall: number | null;
  };
  promptSizeHints: {
    averageChars: number;
    maxChars: number;
  };
  actionCounts: {
    say: number;
    warn: number;
    timeout: number;
  };
  providerFailures: PilotApprovalProviderFailure[];
  blockingIssues: Array<{
    suite: string;
    scenarioId: string;
    stepId: string;
    kind: ScenarioEvaluationIssue["kind"];
    message: string;
  }>;
  advisoryIssues: Array<{
    suite: string;
    scenarioId: string;
    stepId: string;
    kind: ScenarioEvaluationIssue["kind"];
    message: string;
  }>;
}

function classifySuite(suite: string): "moderation" | "social" {
  return suite === "social" || suite.startsWith("social-") ? "social" : "moderation";
}

export function combineScenarioResults(
  loadedScenarios: LoadedScenario[],
  results: ScenarioEvaluationResult[],
): PilotApprovalScenarioRecord[] {
  return loadedScenarios.map((loaded, index) => ({
    suite: loaded.suite,
    path: loaded.path,
    hardSafetyBlocker: loaded.scenario.approval.hardSafetyBlocker,
    result: results[index]!,
  }));
}

export function buildPilotApprovalReport(input: {
  config: ConfigSnapshot;
  scenarioResults: PilotApprovalScenarioRecord[];
}): PilotApprovalReport {
  const providerInfo = getConfiguredProviderInfo(input.config);
  const total = input.scenarioResults.length;
  const passed = input.scenarioResults.filter((record) => record.result.passed).length;
  const failed = total - passed;
  const passRate = total === 0 ? 0 : passed / total;
  const moderationResults = input.scenarioResults.filter((record) => classifySuite(record.suite) === "moderation");
  const socialResults = input.scenarioResults.filter((record) => classifySuite(record.suite) === "social");
  const moderationPassed = moderationResults.filter((record) => record.result.passed).length;
  const socialPassed = socialResults.filter((record) => record.result.passed).length;
  const moderationPassRate = moderationResults.length === 0 ? 0 : moderationPassed / moderationResults.length;
  const socialPassRate = socialResults.length === 0 ? 0 : socialPassed / socialResults.length;
  const blockingIssues = input.scenarioResults.flatMap((record) =>
    record.result.issues
      .filter((issue) => issue.severity === "blocking")
      .map((issue) => ({
        suite: record.suite,
        scenarioId: record.result.scenarioId,
        stepId: issue.stepId,
        kind: issue.kind,
        message: issue.message,
      })),
  );
  const advisoryIssues = input.scenarioResults.flatMap((record) =>
    record.result.issues
      .filter((issue) => issue.severity === "advisory")
      .map((issue) => ({
        suite: record.suite,
        scenarioId: record.result.scenarioId,
        stepId: issue.stepId,
        kind: issue.kind,
        message: issue.message,
      })),
  );
  const suiteMap = new Map<
    string,
    {
      kind: "moderation" | "social";
      total: number;
      passed: number;
      failed: number;
      blockingIssues: number;
      advisoryIssues: number;
      wrongfulTimeouts: number;
      blockingMissedTimeouts: number;
    }
  >();

  for (const record of input.scenarioResults) {
    const current = suiteMap.get(record.suite) ?? {
      kind: classifySuite(record.suite),
      total: 0,
      passed: 0,
      failed: 0,
      blockingIssues: 0,
      advisoryIssues: 0,
      wrongfulTimeouts: 0,
      blockingMissedTimeouts: 0,
    };
    current.total += 1;
    current.passed += record.result.passed ? 1 : 0;
    current.failed += record.result.passed ? 0 : 1;
    current.blockingIssues += record.result.blockingIssueCount;
    current.advisoryIssues += record.result.advisoryIssueCount;
    current.wrongfulTimeouts += record.result.issues.filter((issue) => issue.kind === "wrongful_timeout").length;
    current.blockingMissedTimeouts += record.result.issues.filter(
      (issue) => issue.kind === "missed_required_timeout" && issue.severity === "blocking",
    ).length;
    suiteMap.set(record.suite, current);
  }

  const providerFailures: PilotApprovalProviderFailure[] = input.scenarioResults
    .filter((record) => record.result.providerFailureKind)
    .map((record) => ({
      phase: "scenario" as const,
      suite: record.suite,
      scenarioId: record.result.scenarioId,
      failureKind: record.result.providerFailureKind!,
      errorType: record.result.providerErrorType,
      reason: record.result.providerFailureReason ?? "provider failure during scenario evaluation",
    }));
  const promptChars = input.scenarioResults.map((record) => record.result.promptChars);
  const actionCounts = {
    say: input.scenarioResults.reduce(
      (count, record) => count + record.result.actualActionKinds.filter((kind) => kind === "say").length,
      0,
    ),
    warn: input.scenarioResults.reduce(
      (count, record) => count + record.result.actualActionKinds.filter((kind) => kind === "warn").length,
      0,
    ),
    timeout: input.scenarioResults.reduce(
      (count, record) => count + record.result.actualActionKinds.filter((kind) => kind === "timeout").length,
      0,
    ),
  };
  const wrongfulTimeouts = blockingIssues.filter((issue) => issue.kind === "wrongful_timeout").length;
  const blockingMissedTimeouts = blockingIssues.filter((issue) => issue.kind === "missed_required_timeout").length;
  const advisoryMissedTimeouts = advisoryIssues.filter((issue) => issue.kind === "missed_required_timeout").length;
  const otherExpectationMisses = advisoryIssues.filter((issue) => issue.kind === "other_expectation_miss").length;
  const hardSafetyTimeoutSteps = input.scenarioResults.flatMap((record) =>
    record.hardSafetyBlocker ? record.result.steps.filter((step) => step.timeoutRequired) : [],
  );
  const hardSafetyTimeoutSatisfied = hardSafetyTimeoutSteps.filter((step) =>
    step.actualActionKinds.includes("timeout"),
  ).length;
  const timeoutActionsObserved = input.scenarioResults.reduce(
    (count, record) => count + record.result.steps.filter((step) => step.actualActionKinds.includes("timeout")).length,
    0,
  );
  const correctTimeoutActions = Math.max(0, timeoutActionsObserved - wrongfulTimeouts);
  const blockingReasons: string[] = [];

  if (wrongfulTimeouts > 0) {
    blockingReasons.push(`${wrongfulTimeouts} wrongful timeout issue(s) detected.`);
  }

  if (blockingMissedTimeouts > 0) {
    blockingReasons.push(`${blockingMissedTimeouts} blocking missed-timeout issue(s) detected.`);
  }

  if (providerFailures.length > 0) {
    blockingReasons.push(`${providerFailures.length} provider failure(s) occurred during the approval run.`);
  }

  return {
    createdAt: new Date().toISOString(),
    provider: providerInfo.provider,
    model: providerInfo.model,
    promptPack: input.config.prompts.packName,
    approved: blockingReasons.length === 0,
    blockingReasons,
    scenarioTotals: {
      total,
      passed,
      failed,
      passRate,
      moderationTotal: moderationResults.length,
      moderationPassed,
      moderationPassRate,
      socialTotal: socialResults.length,
      socialPassed,
      socialPassRate,
      hardSafetyBlockers: input.scenarioResults.filter((record) => record.hardSafetyBlocker).length,
      hardSafetyTimeoutRequirements: hardSafetyTimeoutSteps.length,
      hardSafetyTimeoutSatisfied,
    },
    suiteSummaries: [...suiteMap.entries()]
      .map(([suite, summary]) => ({
        suite,
        ...summary,
      }))
      .sort((left, right) => left.suite.localeCompare(right.suite)),
    issueTotals: {
      blocking: blockingIssues.length,
      advisory: advisoryIssues.length,
      wrongfulTimeouts,
      blockingMissedTimeouts,
      advisoryMissedTimeouts,
      providerFailures: providerFailures.length,
      otherExpectationMisses,
    },
    timeoutMetrics: {
      timeoutActionsObserved,
      correctTimeoutActions,
      precision: timeoutActionsObserved === 0 ? null : correctTimeoutActions / timeoutActionsObserved,
      hardSafetyTimeoutRecall:
        hardSafetyTimeoutSteps.length === 0 ? null : hardSafetyTimeoutSatisfied / hardSafetyTimeoutSteps.length,
    },
    promptSizeHints: {
      averageChars:
        promptChars.length > 0
          ? Math.round(promptChars.reduce((sum, value) => sum + value, 0) / promptChars.length)
          : 0,
      maxChars: promptChars.length > 0 ? Math.max(...promptChars) : 0,
    },
    actionCounts,
    providerFailures,
    blockingIssues,
    advisoryIssues,
  };
}

export function formatPilotApprovalMarkdown(report: PilotApprovalReport): string {
  const lines = [
    "# Pilot Approval Report",
    "",
    `- Generated at: ${report.createdAt}`,
    `- Provider/model: ${report.provider} / ${report.model}`,
    `- Prompt pack: ${report.promptPack}`,
    `- Automatic verdict: ${report.approved ? "PASS" : "FAIL"}`,
    "",
    "## Scenario Summary",
    "",
    `- Pass rate: ${(report.scenarioTotals.passRate * 100).toFixed(1)}% (${report.scenarioTotals.passed}/${report.scenarioTotals.total})`,
    `- Moderation pass rate: ${(report.scenarioTotals.moderationPassRate * 100).toFixed(1)}% (${report.scenarioTotals.moderationPassed}/${report.scenarioTotals.moderationTotal})`,
    `- Social advisory pass rate: ${
      report.scenarioTotals.socialTotal > 0
        ? `${(report.scenarioTotals.socialPassRate * 100).toFixed(1)}% (${report.scenarioTotals.socialPassed}/${report.scenarioTotals.socialTotal})`
        : "n/a"
    }`,
    `- Hard safety blocker scenarios: ${report.scenarioTotals.hardSafetyBlockers}`,
    `- Prompt size hints: avg ${report.promptSizeHints.averageChars} chars, max ${report.promptSizeHints.maxChars} chars`,
    "",
    "## Timeout Risk",
    "",
    `- Timeout precision: ${
      report.timeoutMetrics.precision === null
        ? "n/a"
        : `${(report.timeoutMetrics.precision * 100).toFixed(1)}% (${report.timeoutMetrics.correctTimeoutActions}/${report.timeoutMetrics.timeoutActionsObserved})`
    }`,
    `- Hard-safety timeout recall: ${
      report.timeoutMetrics.hardSafetyTimeoutRecall === null
        ? "n/a"
        : `${(report.timeoutMetrics.hardSafetyTimeoutRecall * 100).toFixed(1)}% (${report.scenarioTotals.hardSafetyTimeoutSatisfied}/${report.scenarioTotals.hardSafetyTimeoutRequirements})`
    }`,
    "",
    "## Issue Totals",
    "",
    `- Blocking issues: ${report.issueTotals.blocking}`,
    `- Advisory issues: ${report.issueTotals.advisory}`,
    `- Wrongful timeouts: ${report.issueTotals.wrongfulTimeouts}`,
    `- Blocking missed required timeouts: ${report.issueTotals.blockingMissedTimeouts}`,
    `- Advisory missed required timeouts: ${report.issueTotals.advisoryMissedTimeouts}`,
    `- Provider failures: ${report.issueTotals.providerFailures}`,
    `- Other expectation misses: ${report.issueTotals.otherExpectationMisses}`,
    "",
    "## Suite Summary",
    "",
    "| Suite | Kind | Passed | Failed | Blocking | Advisory | Wrongful timeouts | Blocking missed timeouts |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.suiteSummaries.map(
      (summary) =>
        `| ${summary.suite} | ${summary.kind} | ${summary.passed}/${summary.total} | ${summary.failed} | ${summary.blockingIssues} | ${summary.advisoryIssues} | ${summary.wrongfulTimeouts} | ${summary.blockingMissedTimeouts} |`,
    ),
    "",
    "## Action Counts",
    "",
    `- say actions: ${report.actionCounts.say}`,
    `- warn actions: ${report.actionCounts.warn}`,
    `- timeout actions: ${report.actionCounts.timeout}`,
    "",
  ];

  if (report.blockingReasons.length > 0) {
    lines.push("## Blocking Reasons", "");
    for (const reason of report.blockingReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  if (report.blockingIssues.length > 0) {
    lines.push("## Blocking Issues", "");
    for (const issue of report.blockingIssues) {
      lines.push(`- ${issue.suite}/${issue.scenarioId}/${issue.stepId} kind=${issue.kind}: ${issue.message}`);
    }
    lines.push("");
  }

  if (report.advisoryIssues.length > 0) {
    lines.push("## Advisory Issues", "");
    for (const issue of report.advisoryIssues) {
      lines.push(`- ${issue.suite}/${issue.scenarioId}/${issue.stepId} kind=${issue.kind}: ${issue.message}`);
    }
    lines.push("");
  }

  if (report.providerFailures.length > 0) {
    lines.push("## Provider Failures", "");
    for (const failure of report.providerFailures) {
      lines.push(
        `- ${failure.phase}${failure.suite ? `:${failure.suite}` : ""}${
          failure.scenarioId ? `:${failure.scenarioId}` : ""
        } kind=${failure.failureKind} errorType=${failure.errorType ?? "unknown"} reason="${failure.reason}"`,
      );
    }
    lines.push("");
  }

  lines.push("## Operator Note", "");
  lines.push("- `approve:pilot` is curated-scenarios-only. Use `review:inbox` to inspect real captured chat separately before enabling `aimod ai-moderation on`.");

  return lines.join("\n");
}
