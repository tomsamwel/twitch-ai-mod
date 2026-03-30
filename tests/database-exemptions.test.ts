import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BotDatabase } from "../src/storage/database.js";

function createTempDb(): { db: BotDatabase; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimod-test-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = new BotDatabase(dbPath);
  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- Exempt users ---

test("addExemptUser inserts and isUserExempt returns true", () => {
  const { db, cleanup } = createTempDb();
  try {
    const added = db.addExemptUser("spammer123", "moduser");
    assert.equal(added, true);
    assert.equal(db.isUserExempt("spammer123"), true);
  } finally {
    cleanup();
  }
});

test("addExemptUser is case-insensitive", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("SpAmMeR", "moduser");
    assert.equal(db.isUserExempt("spammer"), true);
    assert.equal(db.isUserExempt("SPAMMER"), true);
  } finally {
    cleanup();
  }
});

test("addExemptUser returns false on duplicate", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.addExemptUser("user1", "mod"), true);
    assert.equal(db.addExemptUser("user1", "mod"), false);
  } finally {
    cleanup();
  }
});

test("removeExemptUser removes and returns true, then false on second call", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("user1", "mod");
    assert.equal(db.removeExemptUser("user1"), true);
    assert.equal(db.isUserExempt("user1"), false);
    assert.equal(db.removeExemptUser("user1"), false);
  } finally {
    cleanup();
  }
});

test("listExemptUsers returns all exempt users sorted by creation", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addExemptUser("alpha", "mod1");
    db.addExemptUser("beta", "mod2");
    const list = db.listExemptUsers();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.userLogin, "alpha");
    assert.equal(list[0]!.addedByLogin, "mod1");
    assert.equal(list[1]!.userLogin, "beta");
  } finally {
    cleanup();
  }
});

test("isUserExempt returns false for non-exempt user", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.isUserExempt("nobody"), false);
  } finally {
    cleanup();
  }
});

// --- Runtime blocked terms ---

test("addRuntimeBlockedTerm inserts and listRuntimeBlockedTerms returns it", () => {
  const { db, cleanup } = createTempDb();
  try {
    const added = db.addRuntimeBlockedTerm("raid spam phrase", "moduser");
    assert.equal(added, true);
    const list = db.listRuntimeBlockedTerms();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.term, "raid spam phrase");
    assert.equal(list[0]!.addedByLogin, "moduser");
  } finally {
    cleanup();
  }
});

test("addRuntimeBlockedTerm normalizes to lowercase", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addRuntimeBlockedTerm("BUY CHEAP FOLLOWERS", "mod");
    const list = db.listRuntimeBlockedTerms();
    assert.equal(list[0]!.term, "buy cheap followers");
  } finally {
    cleanup();
  }
});

test("addRuntimeBlockedTerm returns false on duplicate", () => {
  const { db, cleanup } = createTempDb();
  try {
    assert.equal(db.addRuntimeBlockedTerm("spam", "mod"), true);
    assert.equal(db.addRuntimeBlockedTerm("spam", "mod"), false);
  } finally {
    cleanup();
  }
});

test("removeRuntimeBlockedTerm removes and returns true, then false", () => {
  const { db, cleanup } = createTempDb();
  try {
    db.addRuntimeBlockedTerm("bad phrase", "mod");
    assert.equal(db.removeRuntimeBlockedTerm("bad phrase"), true);
    assert.equal(db.listRuntimeBlockedTerms().length, 0);
    assert.equal(db.removeRuntimeBlockedTerm("bad phrase"), false);
  } finally {
    cleanup();
  }
});
