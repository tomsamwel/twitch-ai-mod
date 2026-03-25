import type { ControlCommand } from "../types.js";

function normalizeTokens(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function parseControlCommand(input: string, prefix: string): ControlCommand {
  const tokens = normalizeTokens(input);

  if (tokens.length === 0) {
    throw new Error(`Empty command. Try "${prefix} help".`);
  }

  if (tokens[0]?.toLowerCase() !== prefix.toLowerCase()) {
    throw new Error(`Commands must start with "${prefix}". Try "${prefix} help".`);
  }

  const [_, verb, value] = tokens;

  switch ((verb ?? "").toLowerCase()) {
    case "help":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} help`);
      }
      return { kind: "help" };
    case "status":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} status`);
      }
      return { kind: "status" };
    case "ai":
      return { kind: "set-ai", enabled: parseToggle(value, `${prefix} ai on|off`) };
    case "ai-moderation":
      return {
        kind: "set-ai-moderation",
        enabled: parseToggle(value, `${prefix} ai-moderation on|off`),
      };
    case "social":
      return { kind: "set-social", enabled: parseToggle(value, `${prefix} social on|off`) };
    case "dry-run":
      return { kind: "set-dry-run", enabled: parseToggle(value, `${prefix} dry-run on|off`) };
    case "live-moderation":
      return {
        kind: "set-live-moderation",
        enabled: parseToggle(value, `${prefix} live-moderation on|off`),
      };
    case "pack":
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${prefix} pack <pack-name>`);
      }
      return { kind: "set-pack", packName: value.toLowerCase() };
    case "model":
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${prefix} model <preset-name>`);
      }
      return { kind: "set-model", presetName: value.toLowerCase() };
    case "reset":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} reset`);
      }
      return { kind: "reset" };
    default:
      throw new Error(`Unknown command "${verb ?? ""}". Try "${prefix} help".`);
  }
}

function parseToggle(value: string | undefined, usage: string): boolean {
  if (!value) {
    throw new Error(`Usage: ${usage}`);
  }

  switch (value.toLowerCase()) {
    case "on":
      return true;
    case "off":
      return false;
    default:
      throw new Error(`Usage: ${usage}`);
  }
}
