import assert from "node:assert/strict";
import test from "node:test";

import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { CooldownManager } from "../src/moderation/cooldown-manager.js";
import { RuleEngine } from "../src/moderation/rule-engine.js";
import { createChatEvent, createTestConfig } from "./helpers.js";

test("RuleEngine times out messages that match blocked terms", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "please buy followers here",
      messageParts: [{ type: "text", text: "please buy followers here" }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "action");
  assert.equal(decision.matchedRule, "blocked_term");
  assert.equal(decision.actions[0]?.kind, "timeout");
  assert.equal(decision.actions[0]?.durationSeconds, 300);
});

test("RuleEngine suppresses repeated moderation while cooldown is active", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "buy followers again",
      messageParts: [{ type: "text", text: "buy followers again" }],
    }),
  );

  cooldowns.recordAction({
    kind: "timeout",
    targetUserId: message.chatterId,
  });

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "suppressed");
  assert.equal(decision.actions.length, 0);
});
