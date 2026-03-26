import assert from "node:assert/strict";
import test from "node:test";

import { buildAiDecisionInput, HARD_VIOLATION_KEYWORDS } from "../src/ai/prompt.js";
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
  assert.match(input.prompt.system, /<contract>/u);
  assert.match(input.prompt.system, /what do u even do/u);
  assert.match(input.prompt.system, /help pls/u);
  assert.match(input.prompt.system, /moderationCategory/u);
  assert.match(input.prompt.user, /<ctx>/u);
  // Empty context sections are omitted
  assert.doesNotMatch(input.prompt.user, /<room>/u);
  // Mode signals are included in social mode
  assert.match(input.prompt.user, /<mode_sig>/u);
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
  assert.match(input.prompt.system, /repeated after correction/u);
  assert.match(input.prompt.system, /ordered pair \["timeout", "warn"\]/u);
  assert.match(input.prompt.system, /Only propose timeout/u);
  assert.match(input.prompt.system, /confidence >= 0\.90/u);
  assert.match(input.prompt.system, /spam-escalation timeout requires prior evidence/u);
  assert.doesNotMatch(input.prompt.user, /Required JSON schema:/u);
  // Mode signals are NOT included in moderation mode
  assert.doesNotMatch(input.prompt.user, /<mode_sig>/u);
});

test("buildAiDecisionInput includes annotated examples, false-positive examples, and derived signals", () => {
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

  // Annotated moderation examples with reasoning
  assert.match(input.prompt.system, /maybe help people get followers/u);
  assert.match(input.prompt.system, /send pics or ill find u/u);
  assert.match(input.prompt.system, /shut up bot kys/u);
  assert.match(input.prompt.system, /privileged user, never timeout/u);
  // False-positive examples
  assert.match(input.prompt.system, /gonna headshot that noob/u);
  // Examples come before contract (check ordering)
  const examplesPos = input.prompt.system.indexOf("<examples>");
  const contractPos = input.prompt.system.indexOf("<contract>");
  assert.ok(examplesPos < contractPos, "examples should come before contract");
  // Contract mentions timeout and warn action kinds
  assert.match(input.prompt.system, /\["timeout", "warn"\]/u);
  // Executor gate awareness in contract
  assert.match(input.prompt.system, /confidence >= 0\.90/u);
  assert.match(input.prompt.system, /spam-escalation timeout requires prior evidence/u);
  // Hard-violation keywords from shared constant
  for (const keyword of HARD_VIOLATION_KEYWORDS) {
    assert.ok(input.prompt.system.includes(keyword), `prompt should contain hard-violation keyword "${keyword}"`);
  }
  // Derived signals (simplified)
  assert.match(input.prompt.user, /<signals>/u);
  assert.match(input.prompt.user, /mention_count: 0/u);
  assert.match(input.prompt.user, /recent_same_user_messages: 2/u);
  assert.match(input.prompt.user, /recent_bot_correction: yes/u);
  assert.match(input.prompt.user, /visual_spam: none/u);
});
