import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScenarioFile, scenarioInputSchema } from "../src/eval/scenario-schema.js";

test("normalizeScenarioFile upgrades legacy single-turn scenarios into one-step scripts", () => {
  const normalized = normalizeScenarioFile(
    scenarioInputSchema.parse({
      id: "legacy-scenario",
      description: "legacy format",
      history: {
        messages: [],
        botInteractions: [],
      },
      incomingMessage: {
        at: "2026-03-25T10:00:00.000Z",
        actor: {
          id: "viewer-1",
          login: "viewerone",
          roles: ["viewer"],
        },
        text: "hello there",
      },
      expected: {
        allowedOutcomes: ["abstain"],
      },
    }),
  );

  assert.equal(normalized.seed.messages.length, 0);
  assert.equal(normalized.steps.length, 1);
  assert.equal(normalized.steps[0]?.text, "hello there");
  assert.deepEqual(normalized.steps[0]?.expected.allowedOutcomes, ["abstain"]);
});
