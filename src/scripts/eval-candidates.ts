import { loadConfig } from "../config/load-config.js";
import { BotDatabase } from "../storage/database.js";
import type { ModerationCategory } from "../types.js";

interface EvalCandidatesCliOptions {
  limit: number;
}

function printUsage(): void {
  console.log("Usage: npm run eval:candidates -- [--limit <n>]");
  console.log("");
  console.log("Lists live AI decisions that are good candidates for promotion to eval scenarios.");
  console.log("Shows actions taken, low-confidence decisions, and unreviewed events.");
  console.log("");
  console.log("To promote a candidate to a scenario, use:");
  console.log("  npm run review:promote -- --event-id <id> --suite <suite> --id <slug>");
}

function parseArgs(argv: string[]): EvalCandidatesCliOptions {
  const options: EvalCandidatesCliOptions = { limit: 30 };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--limit": {
        const value = argv[index + 1];
        if (!value || Number.isNaN(Number(value))) {
          throw new Error("--limit requires a numeric value");
        }
        options.limit = Number(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function suggestSuite(category: ModerationCategory | null, hasTimeout: boolean): string {
  switch (category) {
    case "scam":
    case "soft-promo":
      return "promo-scam";
    case "sexual-harassment":
      return "harassment-sexual";
    case "targeted-harassment":
      return hasTimeout ? "escalation" : "future-warn-candidates";
    case "spam-escalation":
      return "escalation";
    case "irl-safety":
      return "irl-safety";
    case "rude-disruption":
    case "other":
      return "future-warn-candidates";
    case "none":
    case null:
      return "edge-cases";
  }
}

function formatConfidence(confidence: number | null): string {
  if (confidence === null) return "  n/a";
  return `${(confidence * 100).toFixed(0).padStart(3)}%`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const database = new BotDatabase(config.storage.sqlitePath);

  try {
    const candidates = database.listEvalCandidates(options.limit);

    if (candidates.length === 0) {
      console.log("No eval candidates found. Run the bot in live mode to generate decisions.");
      return;
    }

    console.log(`Found ${candidates.length} eval candidate(s):\n`);
    console.log("  # | Event ID (first 12)  | Conf  | Outcome | Actions         | Category            | Suggested Suite         | Chatter");
    console.log("  --|----------------------|-------|---------|-----------------|---------------------|-------------------------|--------");

    for (const [index, candidate] of candidates.entries()) {
      const actions = [
        candidate.hasTimeout ? "timeout" : null,
        candidate.hasWarn ? "warn" : null,
      ]
        .filter(Boolean)
        .join(",") || "none";
      const suite = suggestSuite(candidate.category, candidate.hasTimeout);

      console.log(
        `  ${String(index + 1).padStart(2)}| ${candidate.eventId.slice(0, 12).padEnd(21)}| ${formatConfidence(candidate.confidence)} | ${candidate.outcome.padEnd(7)} | ${actions.padEnd(15)} | ${(candidate.category ?? "none").padEnd(19)} | ${suite.padEnd(23)} | ${candidate.chatterLogin}`,
      );
    }

    console.log("");
    console.log("Message text for each candidate:");
    for (const [index, candidate] of candidates.entries()) {
      console.log(`  ${index + 1}. [${candidate.eventId.slice(0, 12)}] ${candidate.text ?? "(no snapshot)"}`);
      console.log(`     reason: ${candidate.reason}`);
    }

    console.log("");
    console.log("To promote a candidate:");
    console.log("  npm run review:promote -- --event-id <full-event-id> --suite <suite> --id <slug>");
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
