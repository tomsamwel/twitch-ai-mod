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
  assert.deepEqual(
    decision.actions.map((action) => action.kind),
    ["timeout", "warn"],
  );
  assert.equal(decision.actions[0]?.durationSeconds, 300);
  assert.equal(decision.actions[1]?.message, config.moderationPolicy.publicNotices.blockedTerm);
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

test("RuleEngine exempts VIP chatters from deterministic timeout moderation", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      badges: {
        vip: "1",
      },
      messageText: "follow for follow",
      messageParts: [{ type: "text", text: "follow for follow" }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.reason, "privileged chatter exempt from deterministic moderation");
  assert.equal(decision.actions.length, 0);
});

test("RuleEngine times out obvious large ASCII art with a companion warn", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "8=========D\n8=========D\n8=========D\n8=========D",
      messageParts: [{ type: "text", text: "8=========D\n8=========D\n8=========D\n8=========D" }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "action");
  assert.equal(decision.matchedRule, "visual_spam_ascii_art");
  assert.deepEqual(
    decision.actions.map((action) => action.kind),
    ["timeout", "warn"],
  );
  assert.equal(decision.actions[1]?.message, config.moderationPolicy.publicNotices.visualSpamAsciiArt);
});

test("RuleEngine does not false-positive on small decorative symbol use", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "☆〜(ゝ。∂) that was neat",
      messageParts: [{ type: "text", text: "☆〜(ゝ。∂) that was neat" }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.actions.length, 0);
});

test("RuleEngine times out messages with excessive repeated characters", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const repeatedText = "AAAAAAAAAAAAA hello";
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: repeatedText,
      messageParts: [{ type: "text", text: repeatedText }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "action");
  assert.equal(decision.matchedRule, "spam_heuristic");
  assert.deepEqual(
    decision.actions.map((action) => action.kind),
    ["timeout", "warn"],
  );
});

test("RuleEngine times out messages with excessive emotes", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const emotes = Array.from({ length: 9 }, (_, index) => ({
    type: "emote" as const,
    text: `Kappa${index}`,
    emote: { id: `emote-${index}` },
  }));
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: emotes.map((e) => e.text).join(" "),
      messageParts: emotes,
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "action");
  assert.equal(decision.matchedRule, "spam_heuristic");
});

test("RuleEngine times out messages with excessive mentions", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const mentions = Array.from({ length: 5 }, (_, index) => ({
    type: "mention" as const,
    text: `@user${index}`,
    mention: { user_id: `uid-${index}`, user_login: `user${index}`, user_name: `user${index}` },
  }));
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: mentions.map((m) => m.text).join(" "),
      messageParts: mentions,
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "action");
  assert.equal(decision.matchedRule, "spam_heuristic");
});

test("RuleEngine passes normal messages without blocked terms or spam", () => {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const engine = new RuleEngine(config, cooldowns);
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "great stream today, love the gameplay!",
      messageParts: [{ type: "text", text: "great stream today, love the gameplay!" }],
    }),
  );

  const decision = engine.evaluate(message);

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.actions.length, 0);
});
