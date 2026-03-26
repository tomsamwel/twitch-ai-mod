import assert from "node:assert/strict";
import test from "node:test";

import { buildAiDecisionInput } from "../src/ai/prompt.js";
import { createChatEvent, createEmptyContext, createTestConfig } from "./helpers.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";

test("buildAiDecisionInput switches to social mode when the bot is mentioned", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(
    createChatEvent({
      messageText: "@testbot hey there",
      messageParts: [
        {
          type: "mention",
          text: "@testbot",
          mention: {
            user_id: "bot-1",
            user_login: "testbot",
            user_name: "TestBot",
          },
        },
      ],
    }),
  );

  const input = buildAiDecisionInput(message, createEmptyContext(), config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  assert.equal(input.mode, "social");
  assert.match(input.prompt.system, /<decision_contract>/u);
  assert.match(input.prompt.system, /what's your goal/u);
  assert.match(input.prompt.system, /please help/u);
  assert.match(input.prompt.system, /moderationCategory/u);
  assert.match(input.prompt.user, /<conversation_context>/u);
  assert.match(input.prompt.user, /<recent_room_context>/u);
});

test("buildAiDecisionInput defaults to moderation mode for ordinary messages", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent());

  const input = buildAiDecisionInput(message, createEmptyContext(), config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  assert.equal(input.mode, "moderation");
  assert.match(input.prompt.system, /repeated after bot correction/u);
  assert.match(input.prompt.system, /ordered pair \["timeout", "warn"\]/u);
  assert.match(input.prompt.system, /Only propose timeout/u);
  assert.match(input.prompt.user, /<policy_summary>/u);
  assert.match(input.prompt.user, /live timeout gate/u);
  assert.doesNotMatch(input.prompt.user, /Required JSON schema:/u);
});

test("buildAiDecisionInput includes compact examples, derived signals, and contrastive no-timeout patterns", () => {
  const config = createTestConfig();
  const message = normalizeChatMessage(createChatEvent());
  const context = {
    recentRoomMessages: [],
    recentUserMessages: [
      {
        eventId: "history-1",
        receivedAt: "2026-03-24T15:00:00.000Z",
        chatterId: "user-1",
        chatterLogin: "viewerone",
        chatterDisplayName: "ViewerOne",
        text: "check my profile for cheap overlays",
        roles: ["viewer"],
        isPrivileged: false,
        isBotMessage: false,
      },
      {
        eventId: "history-2",
        receivedAt: "2026-03-24T15:00:10.000Z",
        chatterId: "user-1",
        chatterLogin: "viewerone",
        chatterDisplayName: "ViewerOne",
        text: "you should totally dm me later",
        roles: ["viewer"],
        isPrivileged: false,
        isBotMessage: false,
      },
    ],
    recentBotInteractions: [
      {
        id: "bot-say-1",
        createdAt: "2026-03-24T15:00:20.000Z",
        kind: "say" as const,
        source: "ai" as const,
        status: "dry-run" as const,
        dryRun: true,
        reason: "brief correction",
        targetUserId: "user-1",
        targetUserName: "viewerone",
        message: "Please stop spamming mentions.",
        processingMode: "scenario" as const,
      },
    ],
  };

  const input = buildAiDecisionInput(message, context, config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  // Compact examples include key contrastive patterns
  assert.match(input.prompt.system, /maybe help people get followers/u);
  assert.match(input.prompt.system, /you should totally dm me later/u);
  assert.match(input.prompt.system, /send me pics or i will come/u);
  assert.match(input.prompt.system, /shut up bot, kill yourself/u);
  assert.match(input.prompt.system, /privileged user exempt/u);
  assert.match(input.prompt.system, /visual spam borderline/u);
  // Full JSON shape anchor
  assert.match(input.prompt.system, /"kind":"timeout"/u);
  assert.match(input.prompt.system, /"kind":"warn"/u);
  // Derived signals
  assert.match(input.prompt.user, /<derived_signals>/u);
  assert.match(input.prompt.user, /mention_count: 0/u);
  assert.match(input.prompt.user, /recent_same_user_messages: 2/u);
  assert.match(input.prompt.user, /recent_bot_correction: yes/u);
  assert.match(input.prompt.user, /visual_spam_score:/u);
});
