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
