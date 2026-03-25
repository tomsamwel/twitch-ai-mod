import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewInboxReport } from "../src/review/inbox.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";
import { BotDatabase } from "../src/storage/database.js";
import type { ActionRequest, ActionResult, AiDecision, TwitchIdentity } from "../src/types.js";
import { createChatEvent } from "./helpers.js";

test("buildReviewInboxReport surfaces timeout candidates, provider failures, and stored review decisions", () => {
  const database = new BotDatabase(":memory:");
  const bot: TwitchIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "testbot",
  };

  try {
    const snapshot = normalizeChatMessage(
      createChatEvent({
        messageId: "event-1",
        messageText: "buy followers now",
        chatterId: "viewer-1",
        chatterName: "viewerone",
        chatterDisplayName: "ViewerOne",
      }),
      new Date("2026-03-25T10:00:00.000Z"),
    );

    database.recordMessageSnapshot(snapshot, bot);
    database.recordAiDecision(snapshot, {
      source: "ollama",
      outcome: "abstain",
      reason: "provider returned invalid output",
      confidence: 0,
      mode: "moderation",
      actions: [],
      metadata: {
        failureKind: "invalid_output",
        errorType: "SyntaxError",
      },
    } satisfies AiDecision);
    database.recordAction(
      {
        id: "action-1",
        kind: "timeout",
        source: "rules",
        sourceEventId: snapshot.eventId,
        sourceMessageId: snapshot.sourceMessageId,
        processingMode: "live",
        dryRun: true,
        initiatedAt: snapshot.receivedAt,
        reason: "matched blocked term",
        targetUserId: snapshot.chatterId,
        targetUserName: snapshot.chatterLogin,
        durationSeconds: 300,
      } satisfies ActionRequest,
      {
        id: "action-1",
        kind: "timeout",
        status: "dry-run",
        dryRun: true,
        reason: "matched blocked term",
      } satisfies ActionResult,
    );
    database.setReviewDecision(snapshot.eventId, "policy-fix", "manual note");

    const report = buildReviewInboxReport({
      database,
      limit: 10,
      windowHours: 24 * 365,
    });

    assert.equal(report.candidateCount, 1);
    assert.deepEqual(report.candidates[0]?.reasons.includes("timeout-candidate"), true);
    assert.deepEqual(report.candidates[0]?.reasons.includes("provider-failure"), true);
    assert.equal(report.candidates[0]?.reviewDecision?.verdict, "policy-fix");
  } finally {
    database.close();
  }
});
