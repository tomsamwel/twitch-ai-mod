import type { ControlCommand } from "../types.js";

function normalizeTokens(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
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
      return { kind: "set-ai", enabled: parseToggle(tokens.length, value, `${prefix} ai on|off`) };
    case "ai-moderation":
      return {
        kind: "set-ai-moderation",
        enabled: parseToggle(tokens.length, value, `${prefix} ai-moderation on|off`),
      };
    case "social":
      return { kind: "set-social", enabled: parseToggle(tokens.length, value, `${prefix} social on|off`) };
    case "dry-run":
      return { kind: "set-dry-run", enabled: parseToggle(tokens.length, value, `${prefix} dry-run on|off`) };
    case "live-moderation":
      return {
        kind: "set-live-moderation",
        enabled: parseToggle(tokens.length, value, `${prefix} live-moderation on|off`),
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
    case "panic":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} panic`);
      }
      return { kind: "panic" };
    case "chill":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} chill`);
      }
      return { kind: "chill" };
    case "off":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} off`);
      }
      return { kind: "off" };
    default:
      throw new Error(`Unknown command "${verb ?? ""}". Try "${prefix} help".`);
  }
}

function parseToggle(tokenCount: number, value: string | undefined, usage: string): boolean {
  if (tokenCount !== 3) {
    throw new Error(`Usage: ${usage}`);
  }

  switch (value?.toLowerCase()) {
    case "on":
      return true;
    case "off":
      return false;
    default:
      throw new Error(`Usage: ${usage}`);
  }
}
