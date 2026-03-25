import { loadConfig } from "../config/load-config.js";
import { BotDatabase } from "../storage/database.js";
import type { ReviewVerdict } from "../types.js";

interface ReviewMarkCliOptions {
  eventId: string;
  verdict: ReviewVerdict;
  notes?: string;
}

const REVIEW_VERDICTS: ReviewVerdict[] = [
  "ignore",
  "keep-for-monitoring",
  "promote-to-scenario",
  "prompt-fix",
  "policy-fix",
];

function printUsage(): void {
  console.log(
    "Usage: npm run review:mark -- --event-id <id> --verdict ignore|keep-for-monitoring|promote-to-scenario|prompt-fix|policy-fix [--notes <text>]",
  );
}

function parseArgs(argv: string[]): ReviewMarkCliOptions {
  const options = {} as Partial<ReviewMarkCliOptions>;

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
      case "--verdict": {
        const value = argv[index + 1] as ReviewVerdict | undefined;
        if (!value || !REVIEW_VERDICTS.includes(value)) {
          throw new Error(`--verdict must be one of: ${REVIEW_VERDICTS.join(", ")}`);
        }
        options.verdict = value;
        index += 1;
        break;
      }
      case "--notes": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--notes requires a value");
        }
        options.notes = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.eventId || !options.verdict) {
    throw new Error("--event-id and --verdict are required");
  }

  return options as ReviewMarkCliOptions;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const database = new BotDatabase(config.storage.sqlitePath);

  try {
    if (!database.getMessageSnapshotByEventId(options.eventId)) {
      throw new Error(`No message snapshot found for event ${options.eventId}`);
    }

    database.setReviewDecision(options.eventId, options.verdict, options.notes ?? null);
    console.log(`Stored review verdict ${options.verdict} for event ${options.eventId}`);
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
