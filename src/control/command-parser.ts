import type { ControlCommand } from "../types.js";

function normalizeTokens(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Returns true if the prefix is a single non-alphanumeric character
 * (e.g. "!" or "."). In this mode commands are written without a space:
 * "!status" rather than "aimod status".
 */
function isGluedPrefix(prefix: string): boolean {
  return prefix.length === 1 && /\W/.test(prefix);
}

/**
 * Normalise tokens to a two-part form [prefix, verb, ...rest] regardless of
 * whether the prefix is glued to the verb ("!status") or separate ("aimod status").
 *
 * Returns null if the tokens don't start with the expected prefix.
 */
function extractPrefixAndVerb(
  tokens: string[],
  prefix: string,
): { matched: boolean; tokens: string[] } {
  if (tokens.length === 0) {
    return { matched: false, tokens };
  }

  if (isGluedPrefix(prefix)) {
    // Glued mode: first token must start with the prefix character.
    // "!status" → ["!", "status"]
    // "!block bad term" → ["!", "block", "bad", "term"]
    if (!tokens[0]!.startsWith(prefix)) {
      return { matched: false, tokens };
    }
    const verb = tokens[0]!.slice(prefix.length);
    return { matched: true, tokens: [prefix, verb, ...tokens.slice(1)] };
  }

  // Word-prefix mode: first token must exactly equal the prefix.
  if (tokens[0]!.toLowerCase() !== prefix.toLowerCase()) {
    return { matched: false, tokens };
  }
  return { matched: true, tokens };
}

/** Format a usage example that works for both glued and word prefixes. */
function fmt(prefix: string, rest: string): string {
  return isGluedPrefix(prefix) ? `${prefix}${rest}` : `${prefix} ${rest}`;
}

export function parseControlCommand(input: string, prefix: string): ControlCommand {
  const rawTokens = normalizeTokens(input);

  if (rawTokens.length === 0) {
    throw new Error(`Empty command. Try "${fmt(prefix, "help")}".`);
  }

  const { matched, tokens } = extractPrefixAndVerb(rawTokens, prefix);

  if (!matched) {
    throw new Error(`Commands must start with "${prefix}". Try "${fmt(prefix, "help")}".`);
  }

  const ALIASES: Record<string, string> = {
    aim: "ai-moderation",
    live: "live-moderation",
    dry: "dry-run",
    soc: "social",
    greet: "greetings",
    greeting: "greetings",
  };

  const rawVerb = (tokens[1] ?? "").toLowerCase();
  const verb = ALIASES[rawVerb] ?? rawVerb;
  const value = tokens[2];

  switch (verb) {
    case "help":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "help")}`);
      }
      return { kind: "help" };
    case "status":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "status")}`);
      }
      return { kind: "status" };
    case "ai":
      return { kind: "set-ai", enabled: parseToggle(tokens.length, value, fmt(prefix, "ai on|off")) };
    case "ai-moderation":
      return {
        kind: "set-ai-moderation",
        enabled: parseToggle(tokens.length, value, fmt(prefix, "ai-moderation on|off")),
      };
    case "social":
      return { kind: "set-social", enabled: parseToggle(tokens.length, value, fmt(prefix, "social on|off")) };
    case "greetings":
      return { kind: "set-greetings", enabled: parseToggle(tokens.length, value, fmt(prefix, "greet on|off")) };
    case "dry-run":
      return { kind: "set-dry-run", enabled: parseToggle(tokens.length, value, fmt(prefix, "dry-run on|off")) };
    case "live-moderation":
      return {
        kind: "set-live-moderation",
        enabled: parseToggle(tokens.length, value, fmt(prefix, "live-moderation on|off")),
      };
    case "pack":
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "pack <pack-name>")}`);
      }
      return { kind: "set-pack", packName: value.toLowerCase() };
    case "model":
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "model <preset-name>")}`);
      }
      return { kind: "set-model", presetName: value.toLowerCase() };
    case "reset":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "reset")}`);
      }
      return { kind: "reset" };
    case "panic":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "panic")}`);
      }
      return { kind: "panic" };
    case "chill":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "chill")}`);
      }
      return { kind: "chill" };
    case "off":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "off")}`);
      }
      return { kind: "off" };
    case "recent": {
      if (tokens.length > 3) {
        throw new Error(`Usage: ${fmt(prefix, "recent [count]")}`);
      }
      const count = value ? Number.parseInt(value, 10) : 3;
      if (Number.isNaN(count) || count < 1 || count > 10 || (value && String(count) !== value)) {
        throw new Error(`Count must be 1-10. Usage: ${fmt(prefix, "recent [count]")}`);
      }
      return { kind: "recent", count };
    }
    case "stats":
      if (tokens.length !== 2) {
        throw new Error(`Usage: ${fmt(prefix, "stats")}`);
      }
      return { kind: "stats" };
    case "exempt": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "exempt <user>")} | ${fmt(prefix, "exempt list")}`);
      }
      if (value.toLowerCase() === "list") {
        return { kind: "exempt", subcommand: "list" };
      }
      return { kind: "exempt", subcommand: "add", userLogin: value.toLowerCase().replace(/^@/, "") };
    }
    case "unexempt": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "unexempt <user>")}`);
      }
      return { kind: "exempt", subcommand: "remove", userLogin: value.toLowerCase().replace(/^@/, "") };
    }
    case "block": {
      if (tokens.length < 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "block <term...>")} | ${fmt(prefix, "block list")}`);
      }
      if (value.toLowerCase() === "list" && tokens.length === 3) {
        return { kind: "block", subcommand: "list" };
      }
      const term = tokens.slice(2).join(" ").toLowerCase();
      return { kind: "block", subcommand: "add", term };
    }
    case "unblock": {
      if (tokens.length < 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "unblock <term...>")}`);
      }
      const term = tokens.slice(2).join(" ").toLowerCase();
      return { kind: "block", subcommand: "remove", term };
    }
    case "purge": {
      if (tokens.length !== 3 || !value) {
        throw new Error(`Usage: ${fmt(prefix, "purge <user>")} | ${fmt(prefix, "purge all")}`);
      }
      const target = value.toLowerCase().replace(/^@/, "");
      return { kind: "purge", target };
    }
    default:
      throw new Error(`Unknown command "${verb}". Try "${fmt(prefix, "help")}".`);
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
