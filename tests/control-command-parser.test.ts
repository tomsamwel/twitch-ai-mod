import assert from "node:assert/strict";
import test from "node:test";

import { parseControlCommand } from "../src/control/command-parser.js";

test("parseControlCommand parses strict toggle and value commands", () => {
  assert.deepEqual(parseControlCommand("aimod ai off", "aimod"), {
    kind: "set-ai",
    enabled: false,
  });

  assert.deepEqual(parseControlCommand("aimod ai-moderation on", "aimod"), {
    kind: "set-ai-moderation",
    enabled: true,
  });

  assert.deepEqual(parseControlCommand("aimod pack witty-mod", "aimod"), {
    kind: "set-pack",
    packName: "witty-mod",
  });

  assert.deepEqual(parseControlCommand("aimod model local-fast", "aimod"), {
    kind: "set-model",
    presetName: "local-fast",
  });
});

test("parseControlCommand parses compound commands (panic, chill, off)", () => {
  assert.deepEqual(parseControlCommand("aimod panic", "aimod"), { kind: "panic" });
  assert.deepEqual(parseControlCommand("aimod chill", "aimod"), { kind: "chill" });
  assert.deepEqual(parseControlCommand("aimod off", "aimod"), { kind: "off" });
});

test("parseControlCommand rejects compound commands with extra tokens", () => {
  assert.throws(() => parseControlCommand("aimod panic now", "aimod"), /Usage: aimod panic/u);
  assert.throws(() => parseControlCommand("aimod chill please", "aimod"), /Usage: aimod chill/u);
  assert.throws(() => parseControlCommand("aimod off now", "aimod"), /Usage: aimod off/u);
});

test("parseControlCommand rejects malformed commands with helpful usage", () => {
  assert.throws(() => parseControlCommand("aimod dry-run maybe", "aimod"), /Usage: aimod dry-run on\|off/u);
  assert.throws(
    () => parseControlCommand("aimod ai-moderation maybe", "aimod"),
    /Usage: aimod ai-moderation on\|off/u,
  );
  assert.throws(() => parseControlCommand("hello there", "aimod"), /must start with "aimod"/u);
});

test("parseControlCommand resolves aliases", () => {
  assert.deepEqual(parseControlCommand("aimod aim on", "aimod"), { kind: "set-ai-moderation", enabled: true });
  assert.deepEqual(parseControlCommand("aimod live off", "aimod"), { kind: "set-live-moderation", enabled: false });
  assert.deepEqual(parseControlCommand("aimod dry on", "aimod"), { kind: "set-dry-run", enabled: true });
  assert.deepEqual(parseControlCommand("aimod soc off", "aimod"), { kind: "set-social", enabled: false });
});

test("parseControlCommand parses recent with optional count", () => {
  assert.deepEqual(parseControlCommand("aimod recent", "aimod"), { kind: "recent", count: 3 });
  assert.deepEqual(parseControlCommand("aimod recent 5", "aimod"), { kind: "recent", count: 5 });
  assert.throws(() => parseControlCommand("aimod recent 0", "aimod"), /1-10/u);
  assert.throws(() => parseControlCommand("aimod recent 11", "aimod"), /1-10/u);
  assert.throws(() => parseControlCommand("aimod recent abc", "aimod"), /1-10/u);
});

test("parseControlCommand parses stats", () => {
  assert.deepEqual(parseControlCommand("aimod stats", "aimod"), { kind: "stats" });
});

test("parseControlCommand parses exempt and unexempt", () => {
  assert.deepEqual(parseControlCommand("aimod exempt spammer123", "aimod"), { kind: "exempt", subcommand: "add", userLogin: "spammer123" });
  assert.deepEqual(parseControlCommand("aimod exempt @SpamUser", "aimod"), { kind: "exempt", subcommand: "add", userLogin: "spamuser" });
  assert.deepEqual(parseControlCommand("aimod exempt list", "aimod"), { kind: "exempt", subcommand: "list" });
  assert.deepEqual(parseControlCommand("aimod unexempt spammer123", "aimod"), { kind: "exempt", subcommand: "remove", userLogin: "spammer123" });
});

test("parseControlCommand parses block and unblock with multi-word terms", () => {
  assert.deepEqual(parseControlCommand("aimod block buy followers", "aimod"), { kind: "block", subcommand: "add", term: "buy followers" });
  assert.deepEqual(parseControlCommand("aimod block list", "aimod"), { kind: "block", subcommand: "list" });
  assert.deepEqual(parseControlCommand("aimod unblock buy followers", "aimod"), { kind: "block", subcommand: "remove", term: "buy followers" });
});

test("parseControlCommand parses purge user and purge all", () => {
  assert.deepEqual(parseControlCommand("aimod purge someuser", "aimod"), { kind: "purge", target: "someuser" });
  assert.deepEqual(parseControlCommand("aimod purge @SomeUser", "aimod"), { kind: "purge", target: "someuser" });
  assert.deepEqual(parseControlCommand("aimod purge all", "aimod"), { kind: "purge", target: "all" });
  assert.throws(() => parseControlCommand("aimod purge", "aimod"), /Usage/u);
});

test("parseControlCommand parses greet/greeting aliases", () => {
  assert.deepEqual(parseControlCommand("aimod greet on", "aimod"), { kind: "set-greetings", enabled: true });
  assert.deepEqual(parseControlCommand("aimod greet off", "aimod"), { kind: "set-greetings", enabled: false });
  assert.deepEqual(parseControlCommand("aimod greeting on", "aimod"), { kind: "set-greetings", enabled: true });
  assert.deepEqual(parseControlCommand("aimod greetings off", "aimod"), { kind: "set-greetings", enabled: false });
});

test("parseControlCommand supports glued single-char prefix (!status)", () => {
  assert.deepEqual(parseControlCommand("!status", "!"), { kind: "status" });
  assert.deepEqual(parseControlCommand("!aim on", "!"), { kind: "set-ai-moderation", enabled: true });
  assert.deepEqual(parseControlCommand("!aim off", "!"), { kind: "set-ai-moderation", enabled: false });
  assert.deepEqual(parseControlCommand("!greet on", "!"), { kind: "set-greetings", enabled: true });
  assert.deepEqual(parseControlCommand("!greet off", "!"), { kind: "set-greetings", enabled: false });
  assert.deepEqual(parseControlCommand("!greeting on", "!"), { kind: "set-greetings", enabled: true });
  assert.deepEqual(parseControlCommand("!block buy followers", "!"), { kind: "block", subcommand: "add", term: "buy followers" });
  assert.deepEqual(parseControlCommand("!recent 5", "!"), { kind: "recent", count: 5 });
});

test("parseControlCommand rejects wrong prefix with glued single-char prefix", () => {
  assert.throws(() => parseControlCommand("?status", "!"), /must start with "!"/u);
  assert.throws(() => parseControlCommand("status", "!"), /must start with "!"/u);
});

test("parseControlCommand rejects unknown verb with glued prefix", () => {
  assert.throws(() => parseControlCommand("!banana", "!"), /Unknown command/u);
});

test("parseControlCommand compound commands with glued prefix", () => {
  assert.deepEqual(parseControlCommand("!panic", "!"), { kind: "panic" });
  assert.deepEqual(parseControlCommand("!chill", "!"), { kind: "chill" });
  assert.deepEqual(parseControlCommand("!off", "!"), { kind: "off" });
  assert.deepEqual(parseControlCommand("!stats", "!"), { kind: "stats" });
});

test("parseControlCommand word-prefix backward compatibility still works", () => {
  assert.deepEqual(parseControlCommand("aimod ai off", "aimod"), { kind: "set-ai", enabled: false });
  assert.deepEqual(parseControlCommand("aimod aim on", "aimod"), { kind: "set-ai-moderation", enabled: true });
  assert.deepEqual(parseControlCommand("aimod panic", "aimod"), { kind: "panic" });
});
