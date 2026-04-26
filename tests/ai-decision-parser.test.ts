import assert from "node:assert/strict";
import test from "node:test";

import { parseAiDecisionText } from "../src/ai/decision-parser.js";
import { createLogger } from "../src/storage/logger.js";
import { createChatEvent, createTestConfig } from "./helpers.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";

test("parseAiDecisionText maps valid say action JSON into an AiDecision", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent());
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "friendly reply is helpful",
      confidence: 0.8,
      mode: "social",
      moderationCategory: "none",
      actions: [
        {
          kind: "say",
          reason: "reply to the viewer",
          message: "hey!",
        },
      ],
    }),
    "ollama",
    {
      mode: "social",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "action");
  assert.equal(decision.actions[0]?.kind, "say");
  assert.equal(decision.actions[0]?.targetUserId, message.chatterId);
  assert.equal(decision.actions[0]?.targetUserName, message.chatterLogin);
  assert.equal(decision.actions[0]?.replyParentMessageId, message.sourceMessageId);
});

test("parseAiDecisionText abstains on malformed JSON", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent());
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    "not valid json",
    "openai",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "abstain");
  assert.equal(decision.actions.length, 0);
  assert.deepEqual(decision.metadata, {
    failureKind: "invalid_output",
    errorType: "SyntaxError",
  });
});

test("parseAiDecisionText normalizes abstain payloads that incorrectly include actions", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "Hi" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "abstain",
      reason: "The current message does not need intervention.",
      confidence: 1,
      mode: "moderation",
      moderationCategory: "none",
      actions: [
        {
          kind: "say",
          reason: "contradictory placeholder action",
        },
      ],
    }),
    "ollama",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "abstain");
  assert.equal(decision.reason, "The current message does not need intervention.");
  assert.equal(decision.actions.length, 0);
});

test("parseAiDecisionText preserves the application-selected mode even if the provider returns a different one", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "@testbot can you help me?" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "direct question deserves a short answer",
      confidence: 0.8,
      mode: "moderation",
      moderationCategory: "none",
      actions: [
        {
          kind: "say",
          reason: "helpful direct reply",
          message: "I keep an eye on chat and step in when it helps.",
        },
      ],
    }),
    "ollama",
    {
      mode: "social",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.mode, "social");
  assert.deepEqual(decision.metadata, {
    providerMode: "moderation",
    normalizedMode: "social",
  });
});

test("parseAiDecisionText maps moderation warn actions into an AiDecision", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "buy my overlays" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "soft promo gets a public warning",
      confidence: 0.82,
      mode: "moderation",
      moderationCategory: "soft-promo",
      actions: [
        {
          kind: "warn",
          reason: "brief promo warning",
          message: "Please keep self-promo out of chat.",
        },
      ],
    }),
    "ollama",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "action");
  assert.equal(decision.actions[0]?.kind, "warn");
  assert.equal(decision.actions[0]?.replyParentMessageId, message.sourceMessageId);
});

test("parseAiDecisionText accepts ordered timeout plus warn moderation actions", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "buy followers now" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "explicit scam",
      confidence: 0.98,
      mode: "moderation",
      moderationCategory: "scam",
      actions: [
        {
          kind: "timeout",
          reason: "explicit scam",
        },
        {
          kind: "warn",
          reason: "public timeout notice",
          message: "Follower-selling scams get timed out.",
        },
      ],
    }),
    "ollama",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "action");
  assert.deepEqual(
    decision.actions.map((action) => action.kind),
    ["timeout", "warn"],
  );
});

test("parseAiDecisionText fills a generic warn fallback when moderation timeout output omits it", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "buy followers now" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "explicit scam",
      confidence: 0.98,
      mode: "moderation",
      moderationCategory: "scam",
      actions: [
        {
          kind: "timeout",
          reason: "explicit scam",
        },
      ],
    }),
    "ollama",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.deepEqual(
    decision.actions.map((action) => action.kind),
    ["timeout", "warn"],
  );
  assert.equal(decision.actions[1]?.message, config.moderationPolicy.publicNotices.generic);
});

test("parseAiDecisionText rejects invalid moderation action combos such as say plus warn", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent({ messageText: "buy followers now" }));
  const logger = createLogger("info", "test");

  const decision = parseAiDecisionText(
    JSON.stringify({
      outcome: "action",
      reason: "invalid combo",
      confidence: 0.8,
      mode: "moderation",
      moderationCategory: "scam",
      actions: [
        {
          kind: "say",
          reason: "bad first action",
          message: "nope",
        },
        {
          kind: "warn",
          reason: "bad second action",
          message: "still nope",
        },
      ],
    }),
    "ollama",
    {
      mode: "moderation",
      isFirstTimeChatter: false,
      greetingEnabled: false,
      message,
      config,
    },
    logger,
  );

  assert.equal(decision.outcome, "abstain");
  assert.deepEqual(decision.metadata, {
    failureKind: "invalid_output",
    errorType: "ZodError",
  });
});
