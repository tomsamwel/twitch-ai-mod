import { getAiFailureMetadata } from "../ai/failure-metadata.js";
import type { BotDatabase } from "../storage/database.js";
import { asRecord } from "../utils.js";
import type {
  PersistedActionRecord,
  PersistedDecisionRecord,
  PersistedMessageSnapshot,
  ReviewDecisionRecord,
} from "../types.js";

const REPEATED_SEQUENCE_WINDOW_MS = 2 * 60 * 1000;

export type ReviewInboxReason =
  | "precision-gated-timeout"
  | "timeout-candidate"
  | "warn-issued"
  | "timeout-notice-skipped"
  | "visual-spam-candidate"
  | "ai-reply"
  | "provider-failure"
  | "cooldown-suppression"
  | "self-loop"
  | "privileged"
  | "repeated-user-sequence";

export interface ReviewInboxCandidate {
  eventId: string;
  sourceMessageId: string;
  receivedAt: string;
  chatterId: string;
  chatterLogin: string;
  chatterDisplayName: string;
  roles: string[];
  text: string;
  reasons: ReviewInboxReason[];
  repeatedSequenceCount: number;
  severityScore: number;
  decisions: Array<{
    stage: PersistedDecisionRecord["stage"];
    outcome: string;
    reason: string;
    providerFailureKind: string | null;
    providerErrorType: string | null;
  }>;
  actions: Array<{
    kind: PersistedActionRecord["kind"];
    source: PersistedActionRecord["source"];
    status: PersistedActionRecord["status"];
    reason: string;
  }>;
  reviewDecision: ReviewDecisionRecord | null;
}

export interface ReviewInboxReport {
  createdAt: string;
  scannedSnapshots: number;
  candidateCount: number;
  reasonCounts: Record<ReviewInboxReason, number>;
  windowHours: number;
  candidates: ReviewInboxCandidate[];
}

function emptyReasonCounts(): Record<ReviewInboxReason, number> {
  return {
    "precision-gated-timeout": 0,
    "timeout-candidate": 0,
    "warn-issued": 0,
    "timeout-notice-skipped": 0,
    "visual-spam-candidate": 0,
    "ai-reply": 0,
    "provider-failure": 0,
    "cooldown-suppression": 0,
    "self-loop": 0,
    privileged: 0,
    "repeated-user-sequence": 0,
  };
}

function scoreReason(reason: ReviewInboxReason): number {
  switch (reason) {
    case "precision-gated-timeout":
      return 110;
    case "timeout-candidate":
      return 100;
    case "timeout-notice-skipped":
      return 95;
    case "visual-spam-candidate":
      return 85;
    case "provider-failure":
      return 90;
    case "warn-issued":
      return 60;
    case "self-loop":
    case "privileged":
      return 80;
    case "repeated-user-sequence":
      return 50;
    case "cooldown-suppression":
      return 40;
    case "ai-reply":
      return 30;
    default:
      return 0;
  }
}

function buildRepeatedSequenceCounts(snapshots: PersistedMessageSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    let repeatedCount = 1;

    for (let lookback = index - 1; lookback >= 0; lookback -= 1) {
      const previous = snapshots[lookback]!;
      const deltaMs = Date.parse(snapshot.receivedAt) - Date.parse(previous.receivedAt);

      if (deltaMs > REPEATED_SEQUENCE_WINDOW_MS) {
        break;
      }

      if (previous.chatterId === snapshot.chatterId) {
        repeatedCount += 1;
      }
    }

    counts.set(snapshot.eventId, repeatedCount);
  }

  return counts;
}

export function buildReviewInboxReport(options: {
  database: Pick<
    BotDatabase,
    "listMessageSnapshots" | "listDecisionsForEventIds" | "listActionsForEventIds" | "listReviewDecisions"
  >;
  limit: number;
  windowHours: number;
}): ReviewInboxReport {
  const sinceMs = Date.now() - options.windowHours * 60 * 60 * 1000;
  const allSnapshots = options.database.listMessageSnapshots(Math.max(options.limit * 4, options.limit));
  const snapshots = allSnapshots.filter((snapshot) => Date.parse(snapshot.receivedAt) >= sinceMs);
  const eventIds = snapshots.map((snapshot) => snapshot.eventId);
  const decisionsByEventId = new Map<string, PersistedDecisionRecord[]>();
  const actionsByEventId = new Map<string, PersistedActionRecord[]>();
  const reviewDecisions = new Map<string, ReviewDecisionRecord>();
  const repeatedSequenceCounts = buildRepeatedSequenceCounts(snapshots);
  const decisions = options.database.listDecisionsForEventIds(eventIds);
  const actions = options.database.listActionsForEventIds(eventIds);

  for (const decision of decisions) {
    const current = decisionsByEventId.get(decision.eventId) ?? [];
    current.push(decision);
    decisionsByEventId.set(decision.eventId, current);
  }

  for (const action of actions) {
    const sourceEventId = action.payload.sourceEventId;
    const current = actionsByEventId.get(sourceEventId) ?? [];
    current.push(action);
    actionsByEventId.set(sourceEventId, current);
  }

  for (const reviewDecision of options.database.listReviewDecisions(eventIds)) {
    reviewDecisions.set(reviewDecision.eventId, reviewDecision);
  }

  const candidates: ReviewInboxCandidate[] = [];
  const reasonCounts = emptyReasonCounts();

  for (const snapshot of snapshots) {
    const reasons = new Set<ReviewInboxReason>();
    const decisionSummaries = (decisionsByEventId.get(snapshot.eventId) ?? []).map((decision) => {
      const providerFailure = decision.stage === "ai" ? getAiFailureMetadata(decision.payload as never) : null;

      if (providerFailure?.failureKind) {
        reasons.add("provider-failure");
      }

      return {
        stage: decision.stage,
        outcome: decision.outcome,
        reason: decision.reason,
        providerFailureKind: providerFailure?.failureKind ?? null,
        providerErrorType: providerFailure?.errorType ?? null,
      };
    });
    const actionSummaries = (actionsByEventId.get(snapshot.eventId) ?? []).map((action) => {
      const effectiveReason = action.result.reason || action.reason;

      if (action.kind === "timeout") {
        reasons.add("timeout-candidate");
      }

      if (action.kind === "warn") {
        reasons.add("warn-issued");
      }

      if (
        action.kind === "timeout" &&
        action.source === "ai" &&
        action.status === "skipped" &&
        effectiveReason.startsWith("AI timeout blocked by precision gate")
      ) {
        reasons.add("precision-gated-timeout");
      }

      if (action.kind === "warn" && effectiveReason === "timeout notice skipped because the preceding timeout did not execute") {
        reasons.add("timeout-notice-skipped");
      }

      if ((action.kind === "say" || action.kind === "warn") && action.source === "ai") {
        reasons.add("ai-reply");
      }

      const payloadMetadata = asRecord(action.payload.metadata);
      const hasVisualSpamSignal =
        payloadMetadata?.timeoutRule === "visual_spam_ascii_art" ||
        action.reason.toLowerCase().includes("visual spam") ||
        action.reason.toLowerCase().includes("ascii art") ||
        effectiveReason.toLowerCase().includes("visual spam") ||
        effectiveReason.toLowerCase().includes("ascii art");

      if (hasVisualSpamSignal) {
        reasons.add("visual-spam-candidate");
      }

      if (action.status === "skipped" && effectiveReason.toLowerCase().includes("cooldown")) {
        reasons.add("cooldown-suppression");
      }

      return {
        kind: action.kind,
        source: action.source,
        status: action.status,
        reason: effectiveReason,
      };
    });

    if (snapshot.message.chatterId === snapshot.botIdentity.id) {
      reasons.add("self-loop");
    }

    if (snapshot.message.isPrivileged) {
      reasons.add("privileged");
    }

    const repeatedSequenceCount = repeatedSequenceCounts.get(snapshot.eventId) ?? 1;
    if (repeatedSequenceCount >= 2) {
      reasons.add("repeated-user-sequence");
    }

    if (reasons.size === 0) {
      continue;
    }

    for (const reason of reasons) {
      reasonCounts[reason] += 1;
    }

    const severityScore =
      [...reasons].reduce((score, reason) => score + scoreReason(reason), 0) + repeatedSequenceCount * 2;

    candidates.push({
      eventId: snapshot.eventId,
      sourceMessageId: snapshot.sourceMessageId,
      receivedAt: snapshot.receivedAt,
      chatterId: snapshot.chatterId,
      chatterLogin: snapshot.chatterLogin,
      chatterDisplayName: snapshot.message.chatterDisplayName,
      roles: snapshot.message.roles,
      text: snapshot.message.text,
      reasons: [...reasons].sort((left, right) => scoreReason(right) - scoreReason(left)),
      repeatedSequenceCount,
      severityScore,
      decisions: decisionSummaries,
      actions: actionSummaries,
      reviewDecision: reviewDecisions.get(snapshot.eventId) ?? null,
    });
  }

  candidates.sort((left, right) => {
    if (right.severityScore !== left.severityScore) {
      return right.severityScore - left.severityScore;
    }

    return right.receivedAt.localeCompare(left.receivedAt);
  });

  return {
    createdAt: new Date().toISOString(),
    scannedSnapshots: snapshots.length,
    candidateCount: Math.min(candidates.length, options.limit),
    reasonCounts,
    windowHours: options.windowHours,
    candidates: candidates.slice(0, options.limit),
  };
}

export function formatReviewInboxMarkdown(report: ReviewInboxReport): string {
  const lines = [
    "# Review Inbox Report",
    "",
    `- Generated at: ${report.createdAt}`,
    `- Window: last ${report.windowHours} hour(s)`,
    `- Snapshots scanned: ${report.scannedSnapshots}`,
    `- Candidates surfaced: ${report.candidateCount}`,
    "",
    "## Reason Counts",
    "",
    ...Object.entries(report.reasonCounts).map(([reason, count]) => `- ${reason}: ${count}`),
    "",
    "## Candidates",
    "",
  ];

  if (report.candidates.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }

  for (const candidate of report.candidates) {
    const reviewSuffix = candidate.reviewDecision
      ? ` review=${candidate.reviewDecision.verdict} @ ${candidate.reviewDecision.updatedAt}`
      : "";
    lines.push(
      `- ${candidate.receivedAt} event=${candidate.eventId} @${candidate.chatterLogin} roles=[${candidate.roles.join(", ")}] reasons=[${candidate.reasons.join(", ")}] seq=${candidate.repeatedSequenceCount} score=${candidate.severityScore}${reviewSuffix}`,
    );
    lines.push(`  text="${candidate.text}"`);

    if (candidate.actions.length > 0) {
      lines.push(
        `  actions=${candidate.actions
          .map((action) => `${action.kind}/${action.source}/${action.status}`)
          .join(", ")}`,
      );
    }

    if (candidate.decisions.length > 0) {
      lines.push(
        `  decisions=${candidate.decisions
          .map((decision) => `${decision.stage}:${decision.outcome}${decision.providerFailureKind ? `:${decision.providerFailureKind}` : ""}`)
          .join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}
