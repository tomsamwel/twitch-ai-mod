import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { loadConfig } from "../config/load-config.js";
import { BotDatabase } from "../storage/database.js";

const SUITES = [
  "adversarial",
  "social-direct",
  "social-quiet",
  "promo-scam",
  "harassment-sexual",
  "privileged-safety",
  "loops-cooldowns",
  "escalation",
  "future-warn-candidates",
] as const;

type ScenarioSuite = (typeof SUITES)[number];

interface ReviewPromoteCliOptions {
  eventId: string;
  suite: ScenarioSuite;
  scenarioId: string;
}

function printUsage(): void {
  console.log(
    "Usage: npm run review:promote -- --event-id <id> --suite social-direct|social-quiet|promo-scam|harassment-sexual|privileged-safety|loops-cooldowns|escalation|future-warn-candidates --id <slug>",
  );
}

function parseArgs(argv: string[]): ReviewPromoteCliOptions {
  const options = {} as Partial<ReviewPromoteCliOptions>;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--event-id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--event-id requires a value");
        }
        options.eventId = value;
        index += 1;
        break;
      }
      case "--suite": {
        const value = argv[index + 1] as ScenarioSuite | undefined;
        if (!value || !SUITES.includes(value)) {
          throw new Error(`--suite must be one of: ${SUITES.join(", ")}`);
        }
        options.suite = value;
        index += 1;
        break;
      }
      case "--id": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--id requires a value");
        }
        options.scenarioId = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.eventId || !options.suite || !options.scenarioId) {
    throw new Error("--event-id, --suite, and --id are required");
  }

  return options as ReviewPromoteCliOptions;
}

function inferExpected(snapshotText: string, actions: ReturnType<BotDatabase["listActionsForEventIds"]>) {
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
      ...(warnAction ? { replyShouldContainAny: [warnAction.payload.message?.split(/\s+/u)[0]!.toLowerCase()] } : {}),
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
      allowedActionStatuses: ["dry-run"],
      forbiddenActionKinds: ["timeout"],
      replyShouldContainAny: snapshotText.length > 0 ? [snapshotText.split(/\s+/u)[0]!.toLowerCase()] : undefined,
    };
  }

  return {
    allowedOutcomes: ["abstain", "no_action"],
    allowedActionKinds: [],
    allowedActionStatuses: [],
    forbiddenActionKinds: [],
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const database = new BotDatabase(config.storage.sqlitePath);

  try {
    const snapshot = database.getMessageSnapshotByEventId(options.eventId);

    if (!snapshot) {
      throw new Error(`No message snapshot found for event ${options.eventId}`);
    }

    const targetPath = path.resolve(config.paths.rootDir, "evals/scenarios", options.suite, `${options.scenarioId}.yaml`);
    const priorMessages = database
      .listRecentUserMessageSnapshots(snapshot.chatterId, snapshot.receivedAt, snapshot.eventId, 3)
      .filter((message) => Date.parse(snapshot.receivedAt) - Date.parse(message.receivedAt) <= 5 * 60 * 1000);
    const botInteractions = database.listRecentBotInteractions(snapshot.chatterId, snapshot.receivedAt, 2);
    const actions = database.listActionsForEventIds([snapshot.eventId]);
    const expected = inferExpected(snapshot.message.text, actions);
    const scenarioDocument = {
      id: options.scenarioId,
      description: `Promoted from replay event ${options.eventId}; refine manually before relying on it.`,
      category: options.suite,
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

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, YAML.stringify(scenarioDocument), "utf8");

    database.setReviewDecision(options.eventId, "promote-to-scenario", `Promoted to ${options.suite}/${options.scenarioId}`);
    console.log(`Scaffolded scenario: ${targetPath}`);
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
