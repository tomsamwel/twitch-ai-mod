import { loadConfig } from "../config/load-config.js";
import { buildPromotionPreview, savePromotionScenario } from "../review/promotion.js";
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const database = new BotDatabase(config.storage.sqlitePath);

  try {
    const preview = buildPromotionPreview({
      config,
      database,
      eventId: options.eventId,
      suite: options.suite,
      scenarioId: options.scenarioId,
    });
    const saved = await savePromotionScenario({
      config,
      database,
      eventId: options.eventId,
      suite: options.suite,
      scenarioId: options.scenarioId,
      yaml: preview.yaml,
    });

    console.log(`Scaffolded scenario: ${saved.path}`);
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
