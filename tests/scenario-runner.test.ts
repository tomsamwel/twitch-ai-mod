import assert from "node:assert/strict";
import test from "node:test";

import { runScenarioEvaluation } from "../src/eval/scenario-runner.js";
import { createLogger } from "../src/storage/logger.js";
import type { AiDecision } from "../src/types.js";
import { createTestConfig } from "./helpers.js";

test("runScenarioEvaluation reports a passing social scenario with a dry-run say action", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");
  let decideCalls = 0;

  const result = await runScenarioEvaluation(
    {
      id: "direct-help-request",
      description: "Viewer directly asks the bot for help.",
      category: "social-direct",
      severity: "low",
      tags: [],
      source: "curated",
      futurePreferredAction: "none",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          at: "2026-03-24T15:01:00.000Z",
          actor: {
            id: "viewer-1",
            login: "viewerone",
            displayName: "ViewerOne",
            roles: ["viewer"],
          },
          text: "@testbot please help",
          expected: {
            mode: "social",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["say"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["timeout"],
            replyShouldContainAny: ["help"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          decideCalls += 1;
          return {
            source: "ollama",
            outcome: "action",
            reason: "direct help request",
            confidence: 0.9,
            mode: "social",
            moderationCategory: "none",
            actions: [
              {
                kind: "say",
                reason: "short helpful reply",
                message: "I can help keep chat smooth.",
              },
            ],
          };
        },
      },
    },
  );

  assert.equal(decideCalls, 1);
  assert.equal(result.passed, true);
  assert.equal(result.stepCount, 1);
  assert.equal(result.selectedMode, "social");
  assert.equal(result.actualOutcome, "action");
  assert.deepEqual(result.actualActionKinds, ["say"]);
  assert.deepEqual(result.actualActionStatuses, ["dry-run"]);
});

test("runScenarioEvaluation evaluates scripted multi-turn scenarios step by step", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");
  let decideCalls = 0;

  const result = await runScenarioEvaluation(
    {
      id: "social-repeat",
      description: "A fresh reply suppresses another immediate one.",
      category: "loops-cooldowns",
      severity: "medium",
      tags: [],
      source: "curated",
      futurePreferredAction: "none",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "step-1",
          at: "2026-03-24T15:01:00.000Z",
          actor: {
            id: "viewer-1",
            login: "viewerone",
            displayName: "ViewerOne",
            roles: ["viewer"],
          },
          text: "@testbot please help",
          expected: {
            mode: "social",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["say"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["timeout"],
          },
        },
        {
          id: "step-2",
          at: "2026-03-24T15:01:05.000Z",
          actor: {
            id: "viewer-1",
            login: "viewerone",
            displayName: "ViewerOne",
            roles: ["viewer"],
          },
          text: "@testbot still there?",
          expected: {
            mode: "social",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["say"],
            allowedActionStatuses: ["dry-run", "skipped"],
            forbiddenActionKinds: ["timeout"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          decideCalls += 1;
          return {
            source: "ollama",
            outcome: "action",
            reason: "direct social question",
            confidence: 0.9,
            mode: "social",
            moderationCategory: "none",
            actions: [
              {
                kind: "say",
                reason: "short reply",
                message: "Still here.",
              },
            ],
          };
        },
      },
    },
  );

  assert.equal(decideCalls, 2);
  assert.equal(result.passed, true);
  assert.equal(result.stepCount, 2);
  assert.equal(result.passedSteps, 2);
  assert.deepEqual(result.actualActionKinds, ["say"]);
  assert.deepEqual(result.actualActionStatuses, ["dry-run"]);
  assert.deepEqual(result.steps.map((step) => step.actualActionStatuses), [["dry-run"], ["dry-run"]]);
});

test("runScenarioEvaluation classifies wrongful timeouts as blocking issues", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "wrongful-timeout",
      description: "A timeout where timeout is forbidden should be blocking.",
      category: "future-warn-candidates",
      severity: "medium",
      tags: [],
      source: "curated",
      futurePreferredAction: "none",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "wrongful-timeout-step-1",
          at: "2026-03-24T15:10:00.000Z",
          actor: {
            id: "viewer-2",
            login: "viewertwo",
            displayName: "ViewerTwo",
            roles: ["viewer"],
          },
          text: "this stream sucks check https://hate-site.com",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["abstain", "action"],
            allowedActionKinds: ["say"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["timeout"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "action",
            reason: "bad timeout",
            confidence: 0.98,
            mode: "moderation",
            moderationCategory: "rude-disruption",
            actions: [
              {
                kind: "timeout",
                reason: "wrongful timeout",
                durationSeconds: 60,
              },
            ],
          };
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.blockingIssueCount, 1);
  assert.equal(result.issues[0]?.kind, "wrongful_timeout");
  assert.equal(result.issues[0]?.severity, "blocking");
});

test("runScenarioEvaluation treats missed hard-safety timeouts as blocking issues", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "missed-hard-safety-timeout",
      description: "Missing a required timeout on a hard-safety scenario is blocking.",
      category: "escalation",
      severity: "critical",
      tags: [],
      source: "curated",
      futurePreferredAction: "timeout",
      approval: {
        hardSafetyBlocker: true,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "missed-hard-safety-timeout-step-1",
          at: "2026-03-24T15:15:00.000Z",
          actor: {
            id: "viewer-3",
            login: "viewerthree",
            displayName: "ViewerThree",
            roles: ["viewer"],
          },
          text: "shut up bot, kill yourself",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["timeout"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["say"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "abstain",
            reason: "wrongly abstaining",
            confidence: 0.2,
            mode: "moderation",
            moderationCategory: "none",
            actions: [],
          };
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.blockingIssueCount, 1);
  assert.equal(result.issues[0]?.kind, "missed_required_timeout");
  assert.equal(result.issues[0]?.severity, "blocking");
});

test("runScenarioEvaluation treats missed non-hard-safety timeouts as advisory by default", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "missed-advisory-timeout",
      description: "Missing a non-hard-safety timeout is advisory by default.",
      category: "promo-scam",
      severity: "medium",
      tags: [],
      source: "curated",
      futurePreferredAction: "timeout",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "missed-advisory-timeout-step-1",
          at: "2026-03-24T15:20:00.000Z",
          actor: {
            id: "viewer-4",
            login: "viewerfour",
            displayName: "ViewerFour",
            roles: ["viewer"],
          },
          text: "shut up bot, kill yourself",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["timeout"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["say"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "abstain",
            reason: "wrongly abstaining",
            confidence: 0.2,
            mode: "moderation",
            moderationCategory: "none",
            actions: [],
          };
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.blockingIssueCount, 0);
  assert.equal(result.advisoryIssueCount, 1);
  assert.equal(result.issues[0]?.kind, "missed_required_timeout");
  assert.equal(result.issues[0]?.severity, "advisory");
});

test("runScenarioEvaluation lets scenarios override missed-timeout severity to blocking", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "missed-timeout-override",
      description: "Scenario scoring can force a missed timeout to be blocking.",
      category: "promo-scam",
      severity: "high",
      tags: [],
      source: "curated",
      futurePreferredAction: "timeout",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "missed-timeout-override-step-1",
          at: "2026-03-24T15:25:00.000Z",
          actor: {
            id: "viewer-5",
            login: "viewerfive",
            displayName: "ViewerFive",
            roles: ["viewer"],
          },
          text: "shut up bot, kill yourself",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["timeout"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["say"],
            scoring: {
              missedTimeoutSeverity: "blocking",
            },
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "abstain",
            reason: "wrongly abstaining",
            confidence: 0.2,
            mode: "moderation",
            moderationCategory: "none",
            actions: [],
          };
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.blockingIssueCount, 1);
  assert.equal(result.issues[0]?.kind, "missed_required_timeout");
  assert.equal(result.issues[0]?.severity, "blocking");
});

test("runScenarioEvaluation can require a warn action for moderation-only public notices", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "warn-only-step",
      description: "A moderation warning scenario can require warn explicitly.",
      category: "future-warn-candidates",
      severity: "medium",
      tags: [],
      source: "curated",
      futurePreferredAction: "warn",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "warn-only-step-1",
          at: "2026-03-24T16:00:00.000Z",
          actor: {
            id: "viewer-6",
            login: "warnviewer",
            displayName: "WarnViewer",
            roles: ["viewer"],
          },
          text: "yo check my shop https://myshop.com link is in bio",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["warn"],
            requiredActionKinds: ["warn"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["timeout"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "action",
            reason: "soft promo gets a public warning",
            confidence: 0.8,
            mode: "moderation",
            moderationCategory: "soft-promo",
            actions: [
              {
                kind: "warn",
                reason: "brief promo warning",
                message: "Please keep self-promo out of chat.",
              },
            ],
          };
        },
      },
    },
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.actualActionKinds, ["warn"]);
});

test("runScenarioEvaluation flags timeout-plus-warn order mismatches as advisory issues", async () => {
  const config = createTestConfig();
  const logger = createLogger("warn", "test");

  const result = await runScenarioEvaluation(
    {
      id: "warn-timeout-order-mismatch",
      description: "The required timeout then warn order is enforced.",
      category: "escalation",
      severity: "high",
      tags: [],
      source: "curated",
      futurePreferredAction: "timeout",
      approval: {
        hardSafetyBlocker: false,
      },
      seed: {
        messages: [],
        botInteractions: [],
      },
      steps: [
        {
          id: "warn-timeout-order-mismatch-step-1",
          at: "2026-03-24T16:05:00.000Z",
          actor: {
            id: "viewer-7",
            login: "wrongorder",
            displayName: "WrongOrder",
            roles: ["viewer"],
          },
          text: "send nudes now",
          expected: {
            mode: "moderation",
            allowedOutcomes: ["action"],
            allowedActionKinds: ["timeout", "warn"],
            requiredActionKinds: ["timeout", "warn"],
            requiredActionOrder: ["timeout", "warn"],
            allowedActionStatuses: ["dry-run"],
            forbiddenActionKinds: ["say"],
          },
        },
      ],
    },
    {
      config,
      logger,
      aiProvider: {
        kind: "ollama",
        async healthCheck() {},
        async decide(): Promise<AiDecision> {
          return {
            source: "ollama",
            outcome: "action",
            reason: "invalid action order",
            confidence: 0.9,
            mode: "moderation",
            moderationCategory: "scam",
            actions: [
              {
                kind: "warn",
                reason: "public timeout notice",
                message: "Follower-selling scams get timed out.",
              },
              {
                kind: "timeout",
                reason: "explicit scam",
                durationSeconds: 300,
              },
            ],
          };
        },
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.blockingIssueCount, 0);
  assert.equal(result.advisoryIssueCount > 0, true);
  assert.match(result.failures.join("\n"), /required action order/u);
});
