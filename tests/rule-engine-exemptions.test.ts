import assert from "node:assert/strict";
import test from "node:test";

import { RuleEngine } from "../src/moderation/rule-engine.js";
import { CooldownManager } from "../src/moderation/cooldown-manager.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { createChatEvent, createTestConfig } from "./helpers.js";

function createEngine(opts: {
  exemptLogins?: string[];
  runtimeBlockedTerms?: string[];
} = {}) {
  const config = createTestConfig();
  const cooldowns = new CooldownManager(config.cooldowns);
  const exemptSet = new Set(opts.exemptLogins ?? []);
  const runtimeTerms = (opts.runtimeBlockedTerms ?? []).map((t) => ({ term: t }));
  return new RuleEngine(
    config,
    cooldowns,
    (login) => exemptSet.has(login),
    () => runtimeTerms,
  );
}

test("exempt user bypasses blocked term detection", () => {
  const engine = createEngine({ exemptLogins: ["spammer123"] });
  const event = createChatEvent({
    chatterName: "spammer123",
    messageText: "buy followers at my site",
    messageParts: [{ type: "text", text: "buy followers at my site" }],
  });
  const message = normalizeChatMessage(event);
  const decision = engine.evaluate(message);
  assert.equal(decision.outcome, "no_action");
  assert.match(decision.reason, /runtime exemption/u);
});

test("non-exempt user is still caught by blocked terms", () => {
  const engine = createEngine({ exemptLogins: ["someone_else"] });
  const event = createChatEvent({
    chatterName: "badactor",
    messageText: "buy followers at my site",
    messageParts: [{ type: "text", text: "buy followers at my site" }],
  });
  const message = normalizeChatMessage(event);
  const decision = engine.evaluate(message);
  assert.equal(decision.outcome, "action");
});

test("runtime blocked term triggers timeout", () => {
  const engine = createEngine({ runtimeBlockedTerms: ["raid slur phrase"] });
  const event = createChatEvent({
    chatterName: "raiduser",
    messageText: "say the raid slur phrase now",
    messageParts: [{ type: "text", text: "say the raid slur phrase now" }],
  });
  const message = normalizeChatMessage(event);
  const decision = engine.evaluate(message);
  assert.equal(decision.outcome, "action");
  assert.equal(decision.reason, "blocked term");
  assert.equal((decision.metadata as Record<string, unknown>)?.blockedTerm, "raid slur phrase");
});

test("runtime blocked terms do not affect clean messages", () => {
  const engine = createEngine({ runtimeBlockedTerms: ["bad phrase"] });
  const event = createChatEvent({
    chatterName: "normaluser",
    messageText: "hello everyone",
    messageParts: [{ type: "text", text: "hello everyone" }],
  });
  const message = normalizeChatMessage(event);
  const decision = engine.evaluate(message);
  assert.equal(decision.outcome, "no_action");
});
