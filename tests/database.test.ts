import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { BotDatabase } from "../src/storage/database.js";
import { createChatEvent } from "./helpers.js";

test("BotDatabase stores and replays the latest message snapshots in chronological order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-db-"));
  const sqlitePath = path.join(tempDir, "bot.sqlite");
  const database = new BotDatabase(sqlitePath);

  try {
    const first = normalizeChatMessage(createChatEvent({ messageId: "msg-1", messageText: "first" }), new Date("2026-03-24T10:00:00.000Z"));
    const second = normalizeChatMessage(
      createChatEvent({ messageId: "msg-2", messageText: "second" }),
      new Date("2026-03-24T10:05:00.000Z"),
    );
    const botIdentity = {
      id: "bot-1",
      login: "testbot",
      displayName: "TestBot",
    };

    database.recordMessageSnapshot(first, botIdentity);
    database.recordMessageSnapshot(second, botIdentity);

    const snapshots = database.listMessageSnapshots(1);

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.eventId, "msg-2");
    assert.equal(snapshots[0]?.message.text, "second");
    assert.equal(snapshots[0]?.botIdentity.login, "testbot");
  } finally {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BotDatabase persists runtime overrides across reopen", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-db-overrides-"));
  const sqlitePath = path.join(tempDir, "bot.sqlite");

  const firstDatabase = new BotDatabase(sqlitePath);

  try {
    firstDatabase.setRuntimeOverride("aiEnabled", false, {
      userId: "user-1",
      login: "streamer",
    });
    firstDatabase.setRuntimeOverride("modelPreset", "local-fast", {
      userId: "user-1",
      login: "streamer",
    });
  } finally {
    firstDatabase.close();
  }

  const secondDatabase = new BotDatabase(sqlitePath);

  try {
    const overrides = secondDatabase.listRuntimeOverrides();
    assert.equal(overrides.length, 2);
    assert.equal(overrides[0]?.key, "aiEnabled");
    assert.equal(overrides[0]?.value, false);
    assert.equal(overrides[1]?.key, "modelPreset");
    assert.equal(overrides[1]?.value, "local-fast");
  } finally {
    secondDatabase.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("BotDatabase creates indexes for replay and review hot paths", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-db-indexes-"));
  const sqlitePath = path.join(tempDir, "bot.sqlite");
  const database = new BotDatabase(sqlitePath);

  try {
    database.close();

    const rawDatabase = new Database(sqlitePath, { readonly: true });

    try {
      const snapshotIndexes = rawDatabase.prepare("PRAGMA index_list(message_snapshots)").all() as Array<{ name: string }>;
      const decisionIndexes = rawDatabase.prepare("PRAGMA index_list(decisions)").all() as Array<{ name: string }>;
      const actionIndexes = rawDatabase.prepare("PRAGMA index_list(actions)").all() as Array<{ name: string }>;

      assert(snapshotIndexes.some((index) => index.name === "idx_message_snapshots_chatter_received_at"));
      assert(decisionIndexes.some((index) => index.name === "idx_decisions_event_created_at"));
      assert(actionIndexes.some((index) => index.name === "idx_actions_source_event_created_at"));
      assert(actionIndexes.some((index) => index.name === "idx_actions_target_user_created_at"));
    } finally {
      rawDatabase.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
