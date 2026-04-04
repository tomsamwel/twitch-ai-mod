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
      moderationCategory: "none",
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

test("buildReviewInboxReport surfaces precision-gated AI timeouts as top-priority review candidates", () => {
  const database = new BotDatabase(":memory:");
  const bot: TwitchIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "testbot",
  };

  try {
    const snapshot = normalizeChatMessage(
      createChatEvent({
        messageId: "event-2",
        messageText: "@testbot @testbot @testbot @testbot @testbot",
        chatterId: "viewer-2",
        chatterName: "viewertwo",
        chatterDisplayName: "ViewerTwo",
      }),
      new Date("2026-03-25T10:05:00.000Z"),
    );

    database.recordMessageSnapshot(snapshot, bot);
    database.recordAction(
      {
        id: "action-2",
        kind: "timeout",
        source: "ai",
        sourceEventId: snapshot.eventId,
        sourceMessageId: snapshot.sourceMessageId,
        processingMode: "live",
        dryRun: false,
        initiatedAt: snapshot.receivedAt,
        reason: "AI escalation",
        targetUserId: snapshot.chatterId,
        targetUserName: snapshot.chatterLogin,
        durationSeconds: 300,
      } satisfies ActionRequest,
      {
        id: "action-2",
        kind: "timeout",
        status: "skipped",
        dryRun: false,
        reason: "AI timeout blocked by precision gate",
      } satisfies ActionResult,
    );

    const report = buildReviewInboxReport({
      database,
      limit: 10,
      windowHours: 24 * 365,
    });

    assert.equal(report.candidateCount, 1);
    assert.deepEqual(report.candidates[0]?.reasons.includes("precision-gated-timeout"), true);
    assert.equal(report.reasonCounts["precision-gated-timeout"], 1);
  } finally {
    database.close();
  }
});

test("buildReviewInboxReport surfaces warn-issued, timeout-notice-skipped, and visual-spam reasons", () => {
  const database = new BotDatabase(":memory:");
  const bot: TwitchIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "testbot",
  };

  try {
    const snapshot = normalizeChatMessage(
      createChatEvent({
        messageId: "event-3",
        messageText: "8=====D\n8=====D\n8=====D",
        chatterId: "viewer-3",
        chatterName: "viewerthree",
        chatterDisplayName: "ViewerThree",
      }),
      new Date("2026-03-25T10:10:00.000Z"),
    );

    database.recordMessageSnapshot(snapshot, bot);
    database.recordAction(
      {
        id: "action-3",
        kind: "warn",
        source: "ai",
        sourceEventId: snapshot.eventId,
        sourceMessageId: snapshot.sourceMessageId,
        processingMode: "live",
        dryRun: false,
        initiatedAt: snapshot.receivedAt,
        reason: "public timeout notice",
        targetUserId: snapshot.chatterId,
        targetUserName: snapshot.chatterLogin,
        message: "Keep giant ASCII art out of chat.",
        metadata: {
          timeoutRule: "visual_spam_ascii_art",
          timeoutCompanion: true,
          companionTimeoutStatus: "skipped",
        },
      } satisfies ActionRequest,
      {
        id: "action-3",
        kind: "warn",
        status: "skipped",
        dryRun: false,
        reason: "timeout notice skipped because the preceding timeout did not execute",
      } satisfies ActionResult,
    );

    const report = buildReviewInboxReport({
      database,
      limit: 10,
      windowHours: 24 * 365,
    });

    assert.equal(report.candidateCount, 1);
    assert.deepEqual(report.candidates[0]?.reasons.includes("warn-issued"), true);
    assert.deepEqual(report.candidates[0]?.reasons.includes("timeout-notice-skipped"), true);
    assert.deepEqual(report.candidates[0]?.reasons.includes("visual-spam-candidate"), true);
  } finally {
    database.close();
  }
});

test("buildReviewInboxReport ignores scenario activity by default", () => {
  const database = new BotDatabase(":memory:");
  const bot: TwitchIdentity = {
    id: "bot-1",
    login: "testbot",
    displayName: "testbot",
  };

  try {
    const snapshot = normalizeChatMessage(
      createChatEvent({
        messageId: "event-scenario",
        messageText: "obviously bad scenario input",
        chatterId: "viewer-scenario",
        chatterName: "scenario_user",
        chatterDisplayName: "ScenarioUser",
      }),
      new Date("2026-03-25T10:15:00.000Z"),
    );

    database.recordMessageSnapshot(snapshot, bot, { processingMode: "scenario" });
    database.recordAction(
      {
        id: "action-scenario-timeout",
        kind: "timeout",
        source: "ai",
        sourceEventId: snapshot.eventId,
        sourceMessageId: snapshot.sourceMessageId,
        processingMode: "scenario",
        dryRun: true,
        initiatedAt: snapshot.receivedAt,
        reason: "scenario timeout",
        targetUserId: snapshot.chatterId,
        targetUserName: snapshot.chatterLogin,
        durationSeconds: 300,
      } satisfies ActionRequest,
      {
        id: "action-scenario-timeout",
        kind: "timeout",
        status: "dry-run",
        dryRun: true,
        reason: "scenario timeout",
      } satisfies ActionResult,
    );

    const report = buildReviewInboxReport({
      database,
      limit: 10,
      windowHours: 24 * 365,
    });

    assert.equal(report.candidateCount, 0);
  } finally {
    database.close();
  }
});
