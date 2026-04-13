import assert from "node:assert/strict";
import test from "node:test";

import { SessionChatterTracker } from "../src/runtime/session-chatter-tracker.js";
import type { GreetingConfig, GreetingPersistence } from "../src/runtime/session-chatter-tracker.js";

const DEFAULT_CONFIG: GreetingConfig = {
  maxQueueDepth: 2,
  rateLimitMs: 60_000,
  greetingCooldownMs: 28_800_000,
  chatterPollIntervalMs: 30_000,
};

function createMockPersistence(): GreetingPersistence & { greeted: Map<string, number> } {
  const greeted = new Map<string, number>();
  return {
    greeted,
    isRecentlyGreeted(userId, windowMs) {
      const at = greeted.get(userId);
      return at !== undefined && (Date.now() - at) < windowMs;
    },
    recordGreeted(userId) {
      greeted.set(userId, Date.now());
    },
  };
}

test("SessionChatterTracker markSeen returns true the first time, false after", () => {
  const tracker = new SessionChatterTracker();
  assert.equal(tracker.markSeen("user-1"), true);
  assert.equal(tracker.markSeen("user-1"), false);
  assert.equal(tracker.markSeen("user-1"), false);
});

test("SessionChatterTracker markSeen tracks different users independently", () => {
  const tracker = new SessionChatterTracker();
  assert.equal(tracker.markSeen("user-1"), true);
  assert.equal(tracker.markSeen("user-2"), true);
  assert.equal(tracker.markSeen("user-1"), false);
  assert.equal(tracker.markSeen("user-2"), false);
});

test("SessionChatterTracker markSeenBulk returns only newly seen IDs", () => {
  const tracker = new SessionChatterTracker();
  tracker.markSeen("user-1");

  const newIds = tracker.markSeenBulk(["user-1", "user-2", "user-3"]);
  assert.deepEqual(newIds, ["user-2", "user-3"]);

  const noneNew = tracker.markSeenBulk(["user-1", "user-2"]);
  assert.deepEqual(noneNew, []);
});

test("SessionChatterTracker shouldGreet returns true when conditions met", () => {
  const persistence = createMockPersistence();
  const tracker = new SessionChatterTracker(persistence);
  tracker.markSeen("user-1");
  const nowMs = Date.now();

  assert.equal(tracker.shouldGreet("user-1", nowMs, 0, DEFAULT_CONFIG), true);
});

test("SessionChatterTracker shouldGreet returns false if recently greeted (DB-backed)", () => {
  const persistence = createMockPersistence();
  const tracker = new SessionChatterTracker(persistence);
  const nowMs = Date.now();
  tracker.markSeen("user-1");
  tracker.markGreeted("user-1", nowMs);

  assert.equal(tracker.shouldGreet("user-1", nowMs, 0, DEFAULT_CONFIG), false);
  assert.equal(persistence.greeted.has("user-1"), true);
});

test("SessionChatterTracker shouldGreet returns false if queue too deep", () => {
  const persistence = createMockPersistence();
  const tracker = new SessionChatterTracker(persistence);
  tracker.markSeen("user-1");
  const nowMs = Date.now();

  assert.equal(tracker.shouldGreet("user-1", nowMs, 3, DEFAULT_CONFIG), false);
  assert.equal(tracker.shouldGreet("user-1", nowMs, 2, DEFAULT_CONFIG), true);
});

test("SessionChatterTracker shouldGreet enforces rate limit", () => {
  const persistence = createMockPersistence();
  const tracker = new SessionChatterTracker(persistence);
  const nowMs = Date.now();

  // Greet user-1
  tracker.markSeen("user-1");
  tracker.markGreeted("user-1", nowMs);

  // user-2 arrives immediately after — rate limit should block
  tracker.markSeen("user-2");
  assert.equal(tracker.shouldGreet("user-2", nowMs + 100, 0, DEFAULT_CONFIG), false);

  // After rate limit expires, user-2 can be greeted
  assert.equal(tracker.shouldGreet("user-2", nowMs + 61_000, 0, DEFAULT_CONFIG), true);
});

test("SessionChatterTracker markGreeted prevents double-greeting via both paths", () => {
  const persistence = createMockPersistence();
  const tracker = new SessionChatterTracker(persistence);
  const nowMs = Date.now();

  // Simulate poll path greets user-1
  tracker.markSeen("user-1");
  tracker.markGreeted("user-1", nowMs - 90_000);  // well before rate limit

  // Simulate user-1 sends first message — should NOT be greeted again
  assert.equal(tracker.shouldGreet("user-1", nowMs, 0, DEFAULT_CONFIG), false);
  assert.equal(persistence.greeted.has("user-1"), true);
});

test("SessionChatterTracker works without persistence (in-memory only for tests)", () => {
  const tracker = new SessionChatterTracker();
  const nowMs = Date.now();
  tracker.markSeen("user-1");

  // Without persistence, shouldGreet always passes the DB check
  assert.equal(tracker.shouldGreet("user-1", nowMs, 0, DEFAULT_CONFIG), true);
  tracker.markGreeted("user-1", nowMs);

  // Rate limit still works without persistence
  tracker.markSeen("user-2");
  assert.equal(tracker.shouldGreet("user-2", nowMs + 100, 0, DEFAULT_CONFIG), false);
});

test("SessionChatterTracker isFirstMessage is independent from markSeen/markSeenBulk", () => {
  const tracker = new SessionChatterTracker();

  // Poll marks user as seen via markSeenBulk
  tracker.markSeenBulk(["user-1"]);
  assert.equal(tracker.markSeen("user-1"), false, "markSeen returns false after poll saw them");

  // But isFirstMessage still returns true — separate tracking
  assert.equal(tracker.isFirstMessage("user-1"), true, "isFirstMessage returns true even after poll saw them");
  assert.equal(tracker.isFirstMessage("user-1"), false, "isFirstMessage returns false on second call");
});
