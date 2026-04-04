import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AiContextBuilder } from "../src/ai/context-builder.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { BotDatabase } from "../src/storage/database.js";
import type { ActionRequest, ActionResult } from "../src/types.js";
import { createChatEvent, createTestConfig } from "./helpers.js";

test("AiContextBuilder assembles recent room context, same-user history, and bot interactions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-context-"));
  const sqlitePath = path.join(tempDir, "bot.sqlite");
  const database = new BotDatabase(sqlitePath);
  const config = createTestConfig();
  const builder = new AiContextBuilder(config, database);
  const botIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  };

  try {
    const roomMessage = normalizeChatMessage(
      createChatEvent({
        messageId: "room-1",
        chatterId: "user-2",
        chatterName: "roomviewer",
        chatterDisplayName: "RoomViewer",
        messageText: "hello room",
      }),
      new Date("2026-03-24T15:00:00.000Z"),
    );
    const priorUserMessage = normalizeChatMessage(
      createChatEvent({
        messageId: "user-1",
        chatterId: "user-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
        messageText: "earlier question",
      }),
      new Date("2026-03-24T15:00:05.000Z"),
    );
    const currentMessage = normalizeChatMessage(
      createChatEvent({
        messageId: "current-1",
        chatterId: "user-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
        messageText: "@testbot can you help?",
      }),
      new Date("2026-03-24T15:00:10.000Z"),
    );

    database.recordMessageSnapshot(roomMessage, botIdentity);
    database.recordMessageSnapshot(priorUserMessage, botIdentity);
    database.recordMessageSnapshot(currentMessage, botIdentity);

    const action: ActionRequest = {
      id: "action-1",
      kind: "say",
      source: "ai",
      sourceEventId: "event-1",
      sourceMessageId: "message-1",
      processingMode: "live",
      dryRun: false,
      initiatedAt: "2026-03-24T15:00:06.000Z",
      reason: "helpful reply",
      message: "I can help with that.",
      targetUserId: "user-1",
      targetUserName: "viewerone",
    };
    const result: ActionResult = {
      id: action.id,
      kind: action.kind,
      status: "executed",
      dryRun: false,
      reason: action.reason,
      externalMessageId: "sent-1",
    };

    database.recordAction(action, result);

    const context = builder.build(currentMessage, botIdentity);

    assert.equal(context.recentRoomMessages.length, 2);
    assert.equal(context.recentRoomMessages[0]?.eventId, "room-1");
    assert.equal(context.recentRoomMessages[1]?.eventId, "user-1");
    assert.equal(context.recentUserMessages.length, 0);
    assert.equal(context.recentBotInteractions.length, 1);
    assert.equal(context.recentBotInteractions[0]?.kind, "say");
    assert.equal(context.recentBotInteractions[0]?.message, "I can help with that.");
  } finally {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AiContextBuilder only reads context from the matching processing mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-context-modes-"));
  const sqlitePath = path.join(tempDir, "bot.sqlite");
  const database = new BotDatabase(sqlitePath);
  const config = createTestConfig();
  const builder = new AiContextBuilder(config, database);
  const botIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  };

  try {
    const liveHistory = normalizeChatMessage(
      createChatEvent({
        messageId: "live-history",
        chatterId: "user-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
        messageText: "live context",
      }),
      new Date("2026-03-24T15:00:00.000Z"),
    );
    const scenarioHistory = normalizeChatMessage(
      createChatEvent({
        messageId: "scenario-history",
        chatterId: "user-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
        messageText: "scenario context",
      }),
      new Date("2026-03-24T15:00:05.000Z"),
    );
    const currentMessage = normalizeChatMessage(
      createChatEvent({
        messageId: "current-message",
        chatterId: "user-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
        messageText: "current",
      }),
      new Date("2026-03-24T15:00:10.000Z"),
    );

    database.recordMessageSnapshot(liveHistory, botIdentity, { processingMode: "live" });
    database.recordMessageSnapshot(scenarioHistory, botIdentity, { processingMode: "scenario" });

    const liveContext = builder.build(currentMessage, botIdentity, "live");
    const scenarioContext = builder.build(currentMessage, botIdentity, "scenario");

    assert.deepEqual(liveContext.recentRoomMessages.map((message) => message.eventId), ["live-history"]);
    assert.deepEqual(scenarioContext.recentRoomMessages.map((message) => message.eventId), ["scenario-history"]);
  } finally {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
