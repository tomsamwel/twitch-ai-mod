import assert from "node:assert/strict";
import test from "node:test";

import { comparePackMetrics, formatCompareMarkdown } from "../src/scripts/eval-compare.js";

test("comparePackMetrics prefers fewer wrongful timeouts before simple pass totals", () => {
  const baseline = {
    passed: 40,
    wrongfulTimeouts: 1,
    blockingMissedTimeouts: 0,
    providerFailures: 0,
    advisoryIssues: 2,
    timeoutPrecision: 0.9,
  };
  const candidate = {
    passed: 38,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 1,
    providerFailures: 0,
    advisoryIssues: 2,
    timeoutPrecision: 1,
  };

  assert.equal(comparePackMetrics(baseline, candidate), 1);
});

test("formatCompareMarkdown lists precision metrics before pass totals", () => {
  const markdown = formatCompareMarkdown({
    createdAt: "2026-03-25T12:00:00.000Z",
    provider: "ollama",
    model: "qwen3:4b-instruct",
    baselinePack: "safer-control",
    candidatePack: "witty-mod",
    baselineManifest: { label: "Safer Control" } as never,
    candidateManifest: { label: "Witty Mod" } as never,
    totals: {
      scenarios: 41,
      baselinePassed: 34,
      candidatePassed: 38,
    },
    ranking: {
      winner: "candidate",
      baseline: {
        passed: 34,
        wrongfulTimeouts: 2,
        blockingMissedTimeouts: 1,
        providerFailures: 0,
        advisoryIssues: 4,
        timeoutPrecision: 0.8,
      },
      candidate: {
        passed: 38,
        wrongfulTimeouts: 0,
        blockingMissedTimeouts: 1,
        providerFailures: 0,
        advisoryIssues: 3,
        timeoutPrecision: 1,
      },
    },
    promptSizeHints: {
      baselineAverageChars: 6000,
      candidateAverageChars: 5800,
    },
    providerFailureCounts: {
      baseline: 0,
      candidate: 0,
    },
    suiteSummaries: [],
    deltas: [],
  });

  assert.ok(markdown.indexOf("Wrongful timeouts") < markdown.indexOf("Baseline passed"));
  assert.match(markdown, /Precision-first winner: candidate/u);
});

test("comparePackMetrics returns 0 when all metrics are equal", () => {
  const metrics = {
    passed: 40,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 0,
    providerFailures: 0,
    advisoryIssues: 2,
    timeoutPrecision: 1,
  };

  assert.equal(comparePackMetrics(metrics, { ...metrics }), 0);
});

test("comparePackMetrics ranks blocking missed timeouts after wrongful timeouts", () => {
  const better = {
    passed: 35,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 2,
    providerFailures: 0,
    advisoryIssues: 5,
    timeoutPrecision: 1,
  };
  const worse = {
    passed: 40,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 3,
    providerFailures: 0,
    advisoryIssues: 0,
    timeoutPrecision: 1,
  };

  assert.equal(comparePackMetrics(better, worse), -1);
  assert.equal(comparePackMetrics(worse, better), 1);
});

test("comparePackMetrics ranks provider failures after blocking missed timeouts", () => {
  const better = {
    passed: 30,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 0,
    providerFailures: 1,
    advisoryIssues: 10,
    timeoutPrecision: 1,
  };
  const worse = {
    passed: 40,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 0,
    providerFailures: 2,
    advisoryIssues: 0,
    timeoutPrecision: 1,
  };

  assert.equal(comparePackMetrics(better, worse), -1);
});

test("comparePackMetrics ranks advisory issues last", () => {
  const fewer = {
    passed: 40,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 0,
    providerFailures: 0,
    advisoryIssues: 1,
    timeoutPrecision: 1,
  };
  const more = {
    passed: 40,
    wrongfulTimeouts: 0,
    blockingMissedTimeouts: 0,
    providerFailures: 0,
    advisoryIssues: 3,
    timeoutPrecision: 1,
  };

  assert.equal(comparePackMetrics(fewer, more), -1);
  assert.equal(comparePackMetrics(more, fewer), 1);
});
