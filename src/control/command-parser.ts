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

  const ALIASES: Record<string, string> = {
    aim: "ai-moderation",
    live: "live-moderation",
    dry: "dry-run",
    soc: "social",
  };

  const rawVerb = (tokens[1] ?? "").toLowerCase();
  const verb = ALIASES[rawVerb] ?? rawVerb;
  const value = tokens[2];

  switch (verb) {
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
    case "recent": {
      if (tokens.length > 3) {
        throw new Error(`Usage: ${prefix} recent [count]`);
      }
      const count = value ? Number.parseInt(value, 10) : 3;
      if (Number.isNaN(count) || count < 1 || count > 10 || (value && String(count) !== value)) {
        throw new Error(`Count must be 1-10. Usage: ${prefix} recent [count]`);
      }
      return { kind: "recent", count };
    }
    case "stats":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${prefix} stats`);
      }
      return { kind: "stats" };
    case "exempt": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${prefix} exempt <user> | ${prefix} exempt list`);
      }
      if (value.toLowerCase() === "list") {
        return { kind: "exempt", subcommand: "list" };
      }
      return { kind: "exempt", subcommand: "add", userLogin: value.toLowerCase().replace(/^@/, "") };
    }
    case "unexempt": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${prefix} unexempt <user>`);
      }
      return { kind: "exempt", subcommand: "remove", userLogin: value.toLowerCase().replace(/^@/, "") };
    }
    case "block": {
      if (tokens.length < 3 || !value) {
        throw new Error(`Usage: ${prefix} block <term...> | ${prefix} block list`);
      }
      if (value.toLowerCase() === "list" && tokens.length === 3) {
        return { kind: "block", subcommand: "list" };
      }
      const term = tokens.slice(2).join(" ").toLowerCase();
      return { kind: "block", subcommand: "add", term };
    }
    case "unblock": {
      if (tokens.length < 3 || !value) {
        throw new Error(`Usage: ${prefix} unblock <term...>`);
      }
      const term = tokens.slice(2).join(" ").toLowerCase();
      return { kind: "block", subcommand: "remove", term };
    }
    case "purge": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${prefix} purge <user> | ${prefix} purge all`);
      }
      const target = value.toLowerCase().replace(/^@/, "");
      return { kind: "purge", target };
    }
    default:
      throw new Error(`Unknown command "${verb}". Try "${prefix} help".`);
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
