import assert from "node:assert/strict";
import test from "node:test";

import {
  createPriorityClassifier,
  workItemCoalesceKey,
  coalesceWorkItems,
  messageRiskScore,
} from "../src/runtime/priority-classifier.js";
import type { PriorityClassifierDeps } from "../src/runtime/priority-classifier.js";
import type { AiReviewWorkItem } from "../src/runtime/message-processor.js";
import type { NormalizedChatMessage, NormalizedMessagePart, TwitchIdentity } from "../src/types.js";

const botIdentity: TwitchIdentity = { id: "bot-1", login: "testbot", displayName: "TestBot" };

function stubDeps(timeoutCount = 0): PriorityClassifierDeps {
  return { countRecentTimeoutsForUser: () => timeoutCount };
}

function makeMessage(overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage {
  return {
    eventId: "evt-1",
    sourceMessageId: "msg-1",
    broadcasterId: "broadcaster-1",
    broadcasterLogin: "testchannel",
    broadcasterDisplayName: "TestChannel",
    chatterId: "user-1",
    chatterLogin: "viewerone",
    chatterDisplayName: "ViewerOne",
    text: "hello world",
    normalizedText: "hello world",
    color: "#00FF00",
    messageType: "text",
    badges: {},
    roles: ["viewer"],
    isPrivileged: false,
    isReply: false,
    replyParentMessageId: null,
    replyParentUserId: null,
    replyParentUserLogin: null,
    replyParentUserDisplayName: null,
    threadMessageId: null,
    threadMessageUserId: null,
    threadMessageUserLogin: null,
    threadMessageUserDisplayName: null,
    isCheer: false,
    bits: 0,
    isRedemption: false,
    rewardId: null,
    sourceBroadcasterId: null,
    sourceBroadcasterLogin: null,
    sourceBroadcasterDisplayName: null,
    sourceChatMessageId: null,
    isSourceOnly: null,
    parts: [{ type: "text", text: "hello world" }] as NormalizedMessagePart[],
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeWorkItem(overrides: {
  message?: Partial<NormalizedChatMessage>;
  mode?: "social" | "moderation";
} = {}): AiReviewWorkItem {
  const message = makeMessage(overrides.message);
  return {
    message,
    botIdentity,
    processingMode: "live",
    nowMs: Date.now(),
    aiMode: {
      mode: overrides.mode ?? "moderation",
      signals: {
        mode: overrides.mode ?? "moderation",
        mentionedBot: false,
        textualMention: false,
        repliedToBot: false,
        threadedWithBot: false,
        rewardTriggered: false,
        broadcasterAddressed: false,
      },
    },
    coalescedCount: 1,
  };
}

test("social mode is always normal priority", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  assert.equal(classify(makeWorkItem({ mode: "social" })), "normal");
});

test("social mode is normal even with risk signals", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    mode: "social",
    message: { text: "CHECK OUT https://scam.com NOW", normalizedText: "check out https://scam.com now" },
  });
  assert.equal(classify(item), "normal");
});

test("moderation + repeat offender is high priority", () => {
  const classify = createPriorityClassifier(stubDeps(1));
  const item = makeWorkItem({
    message: { roles: ["subscriber"], text: "hello" },
  });
  assert.equal(classify(item), "high");
});

test("moderation + URL detected is high priority", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { text: "check this out https://free-skins.com", normalizedText: "check this out https://free-skins.com" },
  });
  assert.equal(classify(item), "high");
});

test("moderation + high caps ratio is high priority", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { text: "YOU ARE SO TRASH AT THIS GAME", normalizedText: "you are so trash at this game" },
  });
  assert.equal(classify(item), "high");
});

test("moderation + 3+ mentions is high priority", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const parts: NormalizedMessagePart[] = [
    { type: "mention", text: "@user1", mentionUserId: "u1", mentionUserLogin: "user1", mentionUserName: "User1" },
    { type: "mention", text: "@user2", mentionUserId: "u2", mentionUserLogin: "user2", mentionUserName: "User2" },
    { type: "mention", text: "@user3", mentionUserId: "u3", mentionUserLogin: "user3", mentionUserName: "User3" },
    { type: "text", text: " you all suck" },
  ];
  const item = makeWorkItem({
    message: { text: "@user1 @user2 @user3 you all suck", parts },
  });
  assert.equal(classify(item), "high");
});

test("moderation + long message is high priority", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const longText = "a".repeat(401);
  const item = makeWorkItem({
    message: { text: longText, normalizedText: longText },
  });
  assert.equal(classify(item), "high");
});

test("moderation + subscriber with no risk signals is normal (trust demotion)", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { roles: ["subscriber"], text: "nice stream today", normalizedText: "nice stream today" },
  });
  assert.equal(classify(item), "normal");
});

test("moderation + cheerer with no risk signals is normal (trust demotion)", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { isCheer: true, bits: 100, text: "great play", normalizedText: "great play" },
  });
  assert.equal(classify(item), "normal");
});

test("moderation + subscriber WITH URL risk signal stays high", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: {
      roles: ["subscriber"],
      text: "check https://sketchy-link.com",
      normalizedText: "check https://sketchy-link.com",
    },
  });
  assert.equal(classify(item), "high");
});

test("moderation + repeat offender WITH trust signals stays high", () => {
  const classify = createPriorityClassifier(stubDeps(2));
  const item = makeWorkItem({
    message: { roles: ["subscriber"], text: "im back", normalizedText: "im back" },
  });
  assert.equal(classify(item), "high");
});

test("moderation + plain viewer with no signals is high (default)", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { text: "hello chat", normalizedText: "hello chat" },
  });
  assert.equal(classify(item), "high");
});

test("short caps text is not flagged as risk (below alpha threshold)", () => {
  const classify = createPriorityClassifier(stubDeps(0));
  const item = makeWorkItem({
    message: { roles: ["subscriber"], text: "GG KEKW", normalizedText: "gg kekw" },
  });
  // Only 6 alpha chars, below CAPS_MIN_ALPHA of 8 — trust demotion applies
  assert.equal(classify(item), "normal");
});

// --- Coalesce key tests ---

test("workItemCoalesceKey returns chatterId for moderation mode", () => {
  const item = makeWorkItem({ mode: "moderation" });
  assert.equal(workItemCoalesceKey(item), item.message.chatterId);
});

test("workItemCoalesceKey returns undefined for social mode", () => {
  const item = makeWorkItem({ mode: "social" });
  assert.equal(workItemCoalesceKey(item), undefined);
});

// --- Coalesce strategy tests ---

test("coalesceWorkItems keeps riskier message", () => {
  const clean = makeWorkItem({ message: { text: "hello", normalizedText: "hello" } });
  const risky = makeWorkItem({
    message: { text: "CHECK THIS OUT https://scam.com BUY NOW", normalizedText: "check this out https://scam.com buy now" },
  });

  const result = coalesceWorkItems(clean, risky, 1);
  assert.equal(result.merged.message.text, risky.message.text, "riskier incoming wins");
  assert.equal(result.count, 2);
});

test("coalesceWorkItems keeps existing when it is riskier", () => {
  const risky = makeWorkItem({
    message: { text: "CHECK THIS OUT https://scam.com BUY NOW", normalizedText: "check this out https://scam.com buy now" },
  });
  const clean = makeWorkItem({ message: { text: "hello", normalizedText: "hello" } });

  const result = coalesceWorkItems(risky, clean, 2);
  assert.equal(result.merged.message.text, risky.message.text, "riskier existing wins");
  assert.equal(result.count, 3);
});

test("coalesceWorkItems prefers incoming on equal risk", () => {
  const a = makeWorkItem({ message: { text: "msg a", normalizedText: "msg a" } });
  const b = makeWorkItem({ message: { text: "msg b", normalizedText: "msg b" } });

  const result = coalesceWorkItems(a, b, 1);
  assert.equal(result.merged.message.text, "msg b", "latest (incoming) wins on tie");
});

test("coalesceWorkItems updates nowMs to incoming", () => {
  const old = makeWorkItem({});
  old.nowMs = 1000;
  const fresh = makeWorkItem({});
  fresh.nowMs = 5000;

  const result = coalesceWorkItems(old, fresh, 1);
  assert.equal(result.merged.nowMs, 5000);
});

// --- Risk score tests ---

test("messageRiskScore is 0 for plain text", () => {
  const msg = makeMessage({ text: "hello", normalizedText: "hello" });
  assert.equal(messageRiskScore(msg), 0);
});

test("messageRiskScore scores URLs highest", () => {
  const msg = makeMessage({ text: "check https://scam.com", normalizedText: "check https://scam.com" });
  assert.ok(messageRiskScore(msg) >= 4);
});

test("messageRiskScore scores all-caps", () => {
  const msg = makeMessage({ text: "AAAAAAAAAA", normalizedText: "aaaaaaaaaa" });
  assert.ok(messageRiskScore(msg) >= 3);
});
