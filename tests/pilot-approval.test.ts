import assert from "node:assert/strict";
import test from "node:test";

import { buildPilotApprovalReport, formatPilotApprovalMarkdown } from "../src/approval/pilot-approval.js";
import type { PilotApprovalScenarioRecord } from "../src/approval/pilot-approval.js";
import { createTestConfig } from "./helpers.js";

function createScenarioRecord(
  overrides: Partial<PilotApprovalScenarioRecord["result"]> = {},
  options: { suite?: string; hardSafetyBlocker?: boolean } = {},
): PilotApprovalScenarioRecord {
  return {
    suite: options.suite ?? "moderation",
    path: "/tmp/scenario.yaml",
    hardSafetyBlocker: options.hardSafetyBlocker ?? false,
    result: {
      scenarioId: "scenario-1",
      description: "test scenario",
      promptPack: "witty-mod",
      provider: "ollama",
      model: "qwen3:4b-instruct",
      stepCount: 1,
      passedSteps: 1,
      selectedMode: "moderation",
      promptChars: 4200,
      actualOutcome: "abstain",
      actualActionKinds: [],
      actualActionStatuses: [],
      replyExcerpt: null,
      providerFailureKind: null,
      providerErrorType: null,
      providerFailureReason: null,
      blockingIssueCount: 0,
      advisoryIssueCount: 0,
      passed: true,
      failures: [],
      issues: [],
      steps: [],
      ...overrides,
    },
  };
}

test("buildPilotApprovalReport blocks approval on wrongful timeouts and provider failures", () => {
  const config = createTestConfig();
  const report = buildPilotApprovalReport({
    config,
    scenarioResults: [
      createScenarioRecord(
        {
          scenarioId: "mild-rude",
          passed: false,
          blockingIssueCount: 1,
          failures: ["forbidden action kind triggered: timeout"],
          issues: [
            {
              stepId: "mild-rude-step-1",
              kind: "wrongful_timeout",
              severity: "blocking",
              message: "forbidden action kind triggered: timeout",
            },
          ],
        },
        { hardSafetyBlocker: true },
      ),
      createScenarioRecord({
        scenarioId: "provider-failure",
        passed: false,
        blockingIssueCount: 1,
        providerFailureKind: "invalid_output",
        providerErrorType: "SyntaxError",
        providerFailureReason: "provider returned invalid structured output",
        failures: ["provider returned invalid structured output"],
        issues: [
          {
            stepId: "provider-failure-step-1",
            kind: "provider_failure",
            severity: "blocking",
            message: "provider returned invalid structured output",
          },
        ],
      }),
    ],
  });

  assert.equal(report.approved, false);
  assert.match(report.blockingReasons.join(" "), /wrongful timeout/u);
  assert.match(report.blockingReasons.join(" "), /provider failure/u);
});

test("formatPilotApprovalMarkdown includes action counts and curated-only operator note", () => {
  const config = createTestConfig();
  const report = buildPilotApprovalReport({
    config,
    scenarioResults: [
      createScenarioRecord({
        scenarioId: "social-help",
        selectedMode: "social",
        actualOutcome: "action",
        actualActionKinds: ["say"],
        actualActionStatuses: ["dry-run"],
        replyExcerpt: "I can help with that.",
      }),
    ],
  });

  const markdown = formatPilotApprovalMarkdown(report);

  assert.match(markdown, /say actions: 1/u);
  assert.match(markdown, /timeout actions: 0/u);
  assert.doesNotMatch(markdown, /Replay Timeout Candidates/u);
  assert.match(markdown, /approve:pilot` is curated-scenarios-only/u);
});

test("buildPilotApprovalReport does not block on social-only failures when moderation passes", () => {
  const config = createTestConfig();
  const report = buildPilotApprovalReport({
    config,
    scenarioResults: [
      createScenarioRecord(
        {
          scenarioId: "social-miss",
          passed: false,
          advisoryIssueCount: 1,
          failures: ["reply did not contain any of: help"],
          issues: [
            {
              stepId: "social-miss-step-1",
              kind: "other_expectation_miss",
              severity: "advisory",
              message: "reply did not contain any of: help",
            },
          ],
        },
        { suite: "social-direct" },
      ),
      createScenarioRecord({
        scenarioId: "moderation-pass",
        passed: true,
      }),
    ],
  });

  assert.equal(report.approved, true);
  assert.equal(report.scenarioTotals.socialPassRate, 0);
  assert.equal(report.scenarioTotals.moderationPassRate, 1);
  assert.equal(report.issueTotals.advisory, 1);
});

test("buildPilotApprovalReport reports the configured provider and model", () => {
  const config = createTestConfig();
  config.ai.provider = "openai";
  const report = buildPilotApprovalReport({
    config,
    scenarioResults: [createScenarioRecord()],
  });

  assert.equal(report.provider, "openai");
  assert.equal(report.model, config.ai.openai.model);
  assert.match(formatPilotApprovalMarkdown(report), /Provider\/model: openai \/ gpt-4o-mini/u);
});
