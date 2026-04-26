import assert from "node:assert/strict";
import test from "node:test";

import { ChatterPollService } from "../src/runtime/chatter-poll-service.js";
import { SessionChatterTracker } from "../src/runtime/session-chatter-tracker.js";
import { createLogger } from "../src/storage/logger.js";

const greetingConfig = {
  maxQueueDepth: 2,
  rateLimitMs: 60_000,
  greetingCooldownMs: 28_800_000,
  chatterPollIntervalMs: 30_000,
};

function buildApiClient(viewers: Array<{ userId: string; userName: string; userDisplayName: string }>) {
  return {
    chat: {
      async getChatters() {
        return { data: viewers };
      },
    },
  };
}

test("ChatterPollService.poll does not write greeted_users DB rows (drop-safe until handler runs)", async () => {
  const greetedUsers = new Set<string>();
  const tracker = new SessionChatterTracker({
    isRecentlyGreeted: (id) => greetedUsers.has(id),
    recordGreeted: (id) => { greetedUsers.add(id); },
  });

  const enqueued: Array<Array<{ id: string; login: string; displayName: string }>> = [];
  const service = new ChatterPollService(
    buildApiClient([
      { userId: "a", userName: "alpha", userDisplayName: "Alpha" },
      { userId: "b", userName: "bravo", userDisplayName: "Bravo" },
    ]),
    "broadcaster-1",
    "bot-1",
    tracker,
    greetingConfig,
    () => 0,
    (viewers) => { enqueued.push(viewers); },
    () => true,
    createLogger("fatal", "test"),
  );

  await (service as unknown as { poll: () => Promise<void> }).poll();

  assert.equal(enqueued.length, 1, "one batch enqueued");
  assert.deepEqual(enqueued[0]!.map((v) => v.id).sort(), ["a", "b"]);
  assert.equal(greetedUsers.size, 0, "no DB rows written at enqueue time — handler is responsible");
});

test("ChatterPollService.poll skips the bot and broadcaster", async () => {
  const tracker = new SessionChatterTracker();
  const enqueued: Array<Array<{ id: string }>> = [];
  const service = new ChatterPollService(
    buildApiClient([
      { userId: "bot-1", userName: "testbot", userDisplayName: "TestBot" },
      { userId: "broadcaster-1", userName: "streamer", userDisplayName: "Streamer" },
      { userId: "viewer-1", userName: "alpha", userDisplayName: "Alpha" },
    ]),
    "broadcaster-1",
    "bot-1",
    tracker,
    greetingConfig,
    () => 0,
    (viewers) => { enqueued.push(viewers); },
    () => true,
    createLogger("fatal", "test"),
  );

  await (service as unknown as { poll: () => Promise<void> }).poll();

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0]!.map((v) => v.id), ["viewer-1"]);
});

test("ChatterPollService.poll returns early when disabled", async () => {
  const tracker = new SessionChatterTracker();
  const enqueued: Array<Array<{ id: string }>> = [];
  const service = new ChatterPollService(
    buildApiClient([{ userId: "a", userName: "alpha", userDisplayName: "Alpha" }]),
    "broadcaster-1",
    "bot-1",
    tracker,
    greetingConfig,
    () => 0,
    (viewers) => { enqueued.push(viewers); },
    () => false,
    createLogger("fatal", "test"),
  );

  await (service as unknown as { poll: () => Promise<void> }).poll();

  assert.equal(enqueued.length, 0);
});
