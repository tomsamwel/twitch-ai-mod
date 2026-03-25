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
  assert.match(input.prompt.system, /Decision instructions:/u);
  assert.match(input.prompt.user, /Current message context:/u);
  assert.match(input.prompt.user, /Recent room context:/u);
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
  assert.match(input.prompt.user, /Required JSON schema:/u);
});
