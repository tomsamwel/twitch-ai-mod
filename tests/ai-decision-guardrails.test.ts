import assert from "node:assert/strict";
import test from "node:test";

import { applyAiDecisionGuardrails } from "../src/ai/decision-guardrails.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import type { AiContextSnapshot, AiDecision } from "../src/types.js";
import { createChatEvent, createTestConfig } from "./helpers.js";

function createHistoryContext(): AiContextSnapshot {
  return {
    recentRoomMessages: [],
    recentUserMessages: [
      {
        eventId: "prior-message",
        receivedAt: "2026-03-24T12:00:00.000Z",
        chatterId: "user-1",
        chatterLogin: "viewerone",
        chatterDisplayName: "ViewerOne",
        text: "buy followers now",
        roles: ["viewer"],
        isPrivileged: false,
        isBotMessage: false,
      },
    ],
    recentBotInteractions: [],
  };
}

test("applyAiDecisionGuardrails converts clean de-escalation moderation actions into abstains", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(
    createChatEvent({
      messageId: "clean-followup",
      messageText: "fair enough, great stream btw",
      messageParts: [
        {
          type: "text",
          text: "fair enough, great stream btw",
        },
      ],
    }),
    new Date("2026-03-24T12:05:00.000Z"),
  );
  const decision: AiDecision = {
    source: "ollama",
    outcome: "action",
    reason: "repeat offender after prior warning",
    confidence: 0.97,
    mode: "moderation",
    moderationCategory: "spam-escalation",
    actions: [
      {
        kind: "timeout",
        reason: "repeat offender after prior warning",
        durationSeconds: 300,
      },
      {
        kind: "warn",
        reason: "public warning",
        message: "That crossed the line. Dial it back.",
      },
    ],
  };

  const guarded = applyAiDecisionGuardrails(decision, message, createHistoryContext(), config);

  assert.equal(guarded.outcome, "abstain");
  assert.equal(guarded.reason, "clean de-escalation follow-up");
  assert.equal(guarded.confidence, 0);
  assert.equal(guarded.moderationCategory, "none");
  assert.deepEqual(guarded.actions, []);
});

test("applyAiDecisionGuardrails does not suppress harmful content that only starts with an apology", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(
    createChatEvent({
      messageId: "harmful-followup",
      messageText: "sorry send nudes now",
      messageParts: [
        {
          type: "text",
          text: "sorry send nudes now",
        },
      ],
    }),
    new Date("2026-03-24T12:06:00.000Z"),
  );
  const decision: AiDecision = {
    source: "ollama",
    outcome: "action",
    reason: "sexual coercion",
    confidence: 0.99,
    mode: "moderation",
    moderationCategory: "sexual-harassment",
    actions: [
      {
        kind: "timeout",
        reason: "sexual coercion",
        durationSeconds: 300,
      },
      {
        kind: "warn",
        reason: "public warning",
        message: "That crossed the line. Dial it back.",
      },
    ],
  };

  const guarded = applyAiDecisionGuardrails(decision, message, createHistoryContext(), config);

  assert.equal(guarded, decision);
});
