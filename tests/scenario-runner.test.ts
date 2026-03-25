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
          at: "2026-03-24T15:01:15.000Z",
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
            allowedActionStatuses: ["skipped"],
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
  assert.deepEqual(result.steps.map((step) => step.actualActionStatuses), [["dry-run"], ["skipped"]]);
});
