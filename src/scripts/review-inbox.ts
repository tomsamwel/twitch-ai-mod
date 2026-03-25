import { loadConfig } from "../config/load-config.js";
import { buildReviewInboxReport, formatReviewInboxMarkdown } from "../review/inbox.js";
import { writeTimestampedReportArtifacts } from "./script-support.js";
import { BotDatabase } from "../storage/database.js";

interface ReviewInboxCliOptions {
  limit: number;
  windowHours: number;
}

function printUsage(): void {
  console.log("Usage: npm run review:inbox -- [--limit <n>] [--window-hours <n>]");
}

function parseArgs(argv: string[]): ReviewInboxCliOptions {
  const options: ReviewInboxCliOptions = {
    limit: 50,
    windowHours: 168,
  };

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
        const parsed = Number.parseInt(value ?? "", 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("--limit must be a positive integer");
        }
        options.limit = parsed;
        index += 1;
        break;
      }
      case "--window-hours": {
        const value = argv[index + 1];
        const parsed = Number.parseInt(value ?? "", 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("--window-hours must be a positive integer");
        }
        options.windowHours = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(process.cwd());
  const database = new BotDatabase(config.storage.sqlitePath);

  try {
    const report = buildReviewInboxReport({
      database,
      limit: options.limit,
      windowHours: options.windowHours,
    });
    const artifacts = await writeTimestampedReportArtifacts(
      config,
      "review-inbox",
      report.createdAt,
      formatReviewInboxMarkdown(report),
      report,
    );

    console.log(
      `Review inbox generated: candidates=${report.candidateCount} scanned=${report.scannedSnapshots} windowHours=${report.windowHours}`,
    );
    console.log(`Markdown report: ${artifacts.markdownPath}`);
    console.log(`JSON report: ${artifacts.jsonPath}`);
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
