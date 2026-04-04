import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { normalizeScenarioFile, scenarioInputSchema } from "../eval/scenario-schema.js";
import type { BotDatabase } from "../storage/database.js";
import type {
  ConfigSnapshot,
  PersistedActionRecord,
  PersistedMessageSnapshot,
  ReviewDecisionRecord,
} from "../types.js";

function inferExpectedFromReplay(
  snapshotText: string,
  actions: ReturnType<BotDatabase["listActionsForEventIds"]>,
) {
  const timeoutAction = actions.find((action) => action.kind === "timeout");
  const warnAction = actions.find((action) => action.kind === "warn");
  const sayAction = actions.find((action) => action.kind === "say");

  if (timeoutAction) {
    return {
      allowedOutcomes: ["action"],
      allowedActionKinds: warnAction ? ["timeout", "warn"] : ["timeout"],
      requiredActionKinds: warnAction ? ["timeout", "warn"] : [],
      ...(warnAction ? { requiredActionOrder: ["timeout", "warn"] } : {}),
      allowedActionStatuses: ["dry-run"],
      forbiddenActionKinds: ["say"],
      ...(warnAction?.payload.message
        ? { replyShouldContainAny: [warnAction.payload.message.split(/\s+/u)[0]!.toLowerCase()] }
        : {}),
    };
  }

  if (warnAction) {
    return {
      allowedOutcomes: ["action"],
      allowedActionKinds: ["warn"],
      requiredActionKinds: ["warn"],
      allowedActionStatuses: ["dry-run"],
      forbiddenActionKinds: ["timeout"],
      replyShouldContainAny:
        warnAction.payload.message && warnAction.payload.message.length > 0
          ? [warnAction.payload.message.split(/\s+/u)[0]!.toLowerCase()]
          : undefined,
    };
  }

  if (sayAction) {
    return {
      allowedOutcomes: ["action"],
      allowedActionKinds: ["say"],
      requiredActionKinds: [],
      allowedActionStatuses: ["dry-run"],
      forbiddenActionKinds: ["timeout"],
      replyShouldContainAny: snapshotText.length > 0 ? [snapshotText.split(/\s+/u)[0]!.toLowerCase()] : undefined,
    };
  }

  return {
    allowedOutcomes: ["abstain", "no_action"],
    allowedActionKinds: [],
    requiredActionKinds: [],
    allowedActionStatuses: [],
    forbiddenActionKinds: [],
  };
}

function buildScenarioDocument(
  suite: string,
  scenarioId: string,
  snapshot: PersistedMessageSnapshot,
  priorMessages: PersistedMessageSnapshot[],
  botInteractions: PersistedActionRecord[],
  actions: ReturnType<BotDatabase["listActionsForEventIds"]>,
) {
  const expected = inferExpectedFromReplay(snapshot.message.text, actions);

  return {
    id: scenarioId,
    description: `Promoted from replay event ${snapshot.eventId}; refine manually before relying on it.`,
    category: suite,
    severity: actions.some((action) => action.kind === "timeout") ? "high" : "medium",
    tags: ["promoted", "manual-cleanup-needed"],
    source: "promoted-replay",
    futurePreferredAction: "none",
    approval: {
      hardSafetyBlocker: false,
    },
    seed: {
      messages: priorMessages.map((message) => ({
        id: message.eventId,
        at: message.receivedAt,
        actor: {
          id: message.message.chatterId,
          login: message.message.chatterLogin,
          displayName: message.message.chatterDisplayName,
          roles: message.message.roles,
        },
        text: message.message.text,
      })),
      botInteractions: botInteractions.map((interaction) => ({
        id: interaction.id,
        at: interaction.createdAt,
        kind: interaction.kind,
        targetActorId: snapshot.chatterId,
        source: interaction.source,
        status: interaction.status,
        reason: interaction.reason,
        ...(interaction.payload.message ? { message: interaction.payload.message } : {}),
        ...(interaction.payload.durationSeconds ? { durationSeconds: interaction.payload.durationSeconds } : {}),
        ...(interaction.result.externalMessageId ? { externalMessageId: interaction.result.externalMessageId } : {}),
      })),
    },
    steps: [
      {
        id: snapshot.eventId,
        at: snapshot.receivedAt,
        actor: {
          id: snapshot.message.chatterId,
          login: snapshot.message.chatterLogin,
          displayName: snapshot.message.chatterDisplayName,
          roles: snapshot.message.roles,
        },
        text: snapshot.message.text,
        expected,
      },
    ],
  };
}

export function buildPromotionPreview(options: {
  config: ConfigSnapshot;
  database: Pick<
    BotDatabase,
    "getMessageSnapshotByEventId" | "listRecentUserMessageSnapshots" | "listRecentBotInteractions" | "listActionsForEventIds"
  >;
  eventId: string;
  suite: string;
  scenarioId: string;
}): { path: string; yaml: string } {
  const snapshot = options.database.getMessageSnapshotByEventId(options.eventId);

  if (!snapshot) {
    throw new Error(`No message snapshot found for event ${options.eventId}`);
  }

  const priorMessages = options.database
    .listRecentUserMessageSnapshots(snapshot.chatterId, snapshot.receivedAt, snapshot.eventId, 3)
    .filter((message) => Date.parse(snapshot.receivedAt) - Date.parse(message.receivedAt) <= 5 * 60 * 1000);
  const botInteractions = options.database.listRecentBotInteractions(snapshot.chatterId, snapshot.receivedAt, 2);
  const actions = options.database.listActionsForEventIds([snapshot.eventId]);
  const scenarioDocument = buildScenarioDocument(
    options.suite,
    options.scenarioId,
    snapshot,
    priorMessages,
    botInteractions,
    actions,
  );
  const targetPath = path.resolve(
    options.config.paths.rootDir,
    "evals/scenarios",
    options.suite,
    `${options.scenarioId}.yaml`,
  );

  return {
    path: targetPath,
    yaml: YAML.stringify(scenarioDocument),
  };
}

export async function savePromotionScenario(options: {
  config: ConfigSnapshot;
  database: Pick<BotDatabase, "setReviewDecision">;
  eventId: string;
  suite: string;
  scenarioId: string;
  yaml: string;
}): Promise<{ path: string; reviewDecision: ReviewDecisionRecord }> {
  const parsedScenario = YAML.parse(options.yaml);
  const normalizedScenario = normalizeScenarioFile(scenarioInputSchema.parse(parsedScenario));

  if (normalizedScenario.id !== options.scenarioId) {
    throw new Error(`Scenario id ${normalizedScenario.id} must match ${options.scenarioId}.`);
  }

  if (normalizedScenario.category !== options.suite) {
    throw new Error(`Scenario category ${normalizedScenario.category} must match suite ${options.suite}.`);
  }

  const targetPath = path.resolve(
    options.config.paths.rootDir,
    "evals/scenarios",
    options.suite,
    `${options.scenarioId}.yaml`,
  );

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, YAML.stringify(normalizedScenario), "utf8");

  const notes = `Promoted to ${options.suite}/${options.scenarioId}`;
  options.database.setReviewDecision(options.eventId, "promote-to-scenario", notes);

  return {
    path: targetPath,
    reviewDecision: {
      eventId: options.eventId,
      verdict: "promote-to-scenario",
      notes,
      updatedAt: new Date().toISOString(),
    },
  };
}
