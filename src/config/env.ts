import { readFile } from "node:fs/promises";
import path from "node:path";

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export async function loadEnvFile(rootDir: string): Promise<void> {
  const envPath = path.resolve(rootDir, ".env");

  try {
    const contents = await readFile(envPath, "utf8");
    const lines = contents.split(/\r?\n/u);

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();

      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = stripWrappingQuotes(rawValue);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}
