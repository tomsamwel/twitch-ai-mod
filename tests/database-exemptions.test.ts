import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotDatabase } from "../src/storage/database.js";
import type { NormalizedChatMessage } from "../src/types.js";

function fakeMessage(overrides: Partial<NormalizedChatMessage> = {}): NormalizedChatMessage {
  return {
    eventId: "evt-1", sourceMessageId: "msg-1", receivedAt: "2026-03-30T10:00:00Z",
    broadcasterId: "b1", broadcasterLogin: "testchannel", broadcasterDisplayName: "TestChannel",
    chatterId: "u1", chatterLogin: "testuser", chatterDisplayName: "TestUser",
    text: "hello", normalizedText: "hello", color: null, messageType: "text",
    badges: {}, roles: [], isPrivileged: false, isReply: false,
    replyParentMessageId: null, replyParentUserId: null, replyParentUserLogin: null, replyParentUserDisplayName: null,
    threadMessageId: null, threadMessageUserId: null, threadMessageUserLogin: null, threadMessageUserDisplayName: null,
    isCheer: false, bits: 0, isRedemption: false, rewardId: null,
    sourceBroadcasterId: null, sourceBroadcasterLogin: null, sourceBroadcasterDisplayName: null,
    sourceChatMessageId: null, isSourceOnly: null, parts: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

function createTempDb(): { db: BotDatabase; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimod-test-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = new BotDatabase(dbPath);
  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- Exempt users ---

test("addExemptUser inserts and isUserExempt returns true", () => {
  const { db, cleanup } = createTempDb();
  try {
    const added = db.addExemptUser("spammer123", "moduser");
    assert.equal(added, true);
    assert.equal(db.isUserExempt("spammer123"), true);
  } finally {
    cleanup();
  }
});

test("addExemptUser is case-insensitive", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("SpAmMeR", "moduser");
    assert.equal(db.isUserExempt("spammer"), true);
    assert.equal(db.isUserExempt("SPAMMER"), true);
  } finally {
    cleanup();
  }
});

test("addExemptUser returns false on duplicate", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.addExemptUser("user1", "mod"), true);
    assert.equal(db.addExemptUser("user1", "mod"), false);
  } finally {
    cleanup();
  }
});

test("removeExemptUser removes and returns true, then false on second call", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("user1", "mod");
    assert.equal(db.removeExemptUser("user1"), true);
    assert.equal(db.isUserExempt("user1"), false);
    assert.equal(db.removeExemptUser("user1"), false);
  } finally {
    cleanup();
  }
});

test("listExemptUsers returns all exempt users sorted by creation", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("alpha", "mod1");
    db.addExemptUser("beta", "mod2");
    const list = db.listExemptUsers();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.userLogin, "alpha");
    assert.equal(list[0]!.addedByLogin, "mod1");
    assert.equal(list[1]!.userLogin, "beta");
  } finally {
    cleanup();
  }
});

test("isUserExempt returns false for non-exempt user", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.isUserExempt("nobody"), false);
  } finally {
    cleanup();
  }
});

// --- Runtime blocked terms ---

test("addRuntimeBlockedTerm inserts and listRuntimeBlockedTerms returns it", () => {
  const { db, cleanup } = createTempDb();
  try {
    const added = db.addRuntimeBlockedTerm("raid spam phrase", "moduser");
    assert.equal(added, true);
    const list = db.listRuntimeBlockedTerms();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.term, "raid spam phrase");
    assert.equal(list[0]!.addedByLogin, "moduser");
  } finally {
    cleanup();
  }
});

test("addRuntimeBlockedTerm normalizes to lowercase", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addRuntimeBlockedTerm("BUY CHEAP FOLLOWERS", "mod");
    const list = db.listRuntimeBlockedTerms();
    assert.equal(list[0]!.term, "buy cheap followers");
  } finally {
    cleanup();
  }
});

test("addRuntimeBlockedTerm returns false on duplicate", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.addRuntimeBlockedTerm("spam", "mod"), true);
    assert.equal(db.addRuntimeBlockedTerm("spam", "mod"), false);
  } finally {
    cleanup();
  }
});

test("removeRuntimeBlockedTerm removes and returns true, then false", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addRuntimeBlockedTerm("bad phrase", "mod");
    assert.equal(db.removeRuntimeBlockedTerm("bad phrase"), true);
    assert.equal(db.listRuntimeBlockedTerms().length, 0);
    assert.equal(db.removeRuntimeBlockedTerm("bad phrase"), false);
  } finally {
    cleanup();
  }
});

// --- Purge operations ---

test("purgeUserHistory deletes messages, decisions, and actions for a user", () => {
  const { db, cleanup } = createTempDb();
  try {
    const msg = fakeMessage({ eventId: "evt-1", sourceMessageId: "msg-1", chatterId: "u1", chatterLogin: "baduser" });
    db.recordMessageSnapshot(msg, { id: "bot-1", login: "testbot", displayName: "TestBot" });
    db.recordRuleDecision(
      { eventId: "evt-1", sourceMessageId: "msg-1", chatterId: "u1", chatterLogin: "baduser" },
      { source: "rules", outcome: "action", reason: "blocked term", matchedRule: "blocked-term", actions: [] },
    );
    db.recordAction(
      {
        id: "act-1", kind: "timeout", source: "rules", sourceEventId: "evt-1", sourceMessageId: "msg-1",
        targetUserId: "u1", targetUserName: "baduser", reason: "blocked", dryRun: false,
        processingMode: "live", initiatedAt: "2026-03-30T10:00:01Z",
      } as Parameters<typeof db.recordAction>[0],
      { id: "act-1", kind: "timeout", status: "executed", dryRun: false, reason: "blocked" },
    );

    const result = db.purgeUserHistory("baduser");
    assert.equal(result.messages, 1);
    assert.equal(result.decisions, 1);
    assert.equal(result.actions, 1);

    const history = db.getUserHistory("baduser");
    assert.equal(history.messages.length, 0);
    assert.equal(history.decisions.length, 0);
    assert.equal(history.actions.length, 0);
  } finally {
    cleanup();
  }
});

test("purgeOperationalData clears all operational tables but preserves config", () => {
  const { db, cleanup } = createTempDb();
  try {
    const msg = fakeMessage({ eventId: "evt-1", sourceMessageId: "msg-1", chatterId: "u1", chatterLogin: "user1" });
    db.recordMessageSnapshot(msg, { id: "bot-1", login: "testbot", displayName: "TestBot" });
    db.recordRuleDecision(
      { eventId: "evt-1", sourceMessageId: "msg-1", chatterId: "u1", chatterLogin: "user1" },
      { source: "rules", outcome: "no_action", reason: "clean", actions: [] },
    );

    db.addExemptUser("vip", "mod");
    db.addRuntimeBlockedTerm("spam", "mod");

    const result = db.purgeOperationalData();
    assert.ok(result.messages >= 1);
    assert.ok(result.decisions >= 1);

    // Config data preserved
    assert.equal(db.isUserExempt("vip"), true);
    assert.equal(db.listRuntimeBlockedTerms().length, 1);
  } finally {
    cleanup();
  }
});
