import assert from "node:assert/strict";
import test from "node:test";

import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { createChatEvent } from "./helpers.js";

test("normalizeChatMessage maps Twitch chat event data into internal shape", () => {
  const event = createChatEvent({
    badges: {
      moderator: "1",
      subscriber: "12",
    },
    parentMessageId: "parent-1",
    parentMessageUserId: "user-2",
    parentMessageUserName: "anotherviewer",
    parentMessageUserDisplayName: "AnotherViewer",
    messageText: "@streamer hello Kappa",
    messageParts: [
      {
        type: "mention",
        text: "@streamer",
        mention: {
          user_id: "broadcaster-1",
          user_login: "testchannel",
          user_name: "TestChannel",
        },
      },
      {
        type: "text",
        text: " hello ",
      },
      {
        type: "emote",
        text: "Kappa",
        emote: {
          id: "25",
        },
      },
    ],
  });

  const normalized = normalizeChatMessage(event, new Date("2026-03-22T18:00:00.000Z"));

  assert.equal(normalized.eventId, "msg-1");
  assert.equal(normalized.isPrivileged, true);
  assert.deepEqual(normalized.roles, ["moderator", "subscriber"]);
  assert.equal(normalized.isReply, true);
  assert.equal(normalized.parts[0]?.type, "mention");
  assert.equal(normalized.parts[2]?.emoteId, "25");
});
