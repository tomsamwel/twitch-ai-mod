import assert from "node:assert/strict";
import test from "node:test";

import { AiReviewQueue } from "../src/runtime/ai-review-queue.js";
import type { CoalesceResult, Priority, PressureState } from "../src/runtime/ai-review-queue.js";
import { createLogger } from "../src/storage/logger.js";

const logger = createLogger("error", "test");

function createQueue(overrides: {
  capacity?: number;
  concurrency?: number;
  moderationStalenessMs?: number;
  socialStalenessMs?: number;
  classify?: (item: number) => Priority;
  onPressure?: (state: PressureState) => void;
} = {}) {
  return new AiReviewQueue<number>(
    {
      capacity: overrides.capacity ?? 5,
      concurrency: overrides.concurrency ?? 1,
      moderationStalenessMs: overrides.moderationStalenessMs ?? 0,
      socialStalenessMs: overrides.socialStalenessMs ?? 30_000,
    },
    logger,
    overrides.classify ?? ((n) => (n > 100 ? "high" : "normal")),
    overrides.onPressure,
  );
}

test("AiReviewQueue throws if enqueue is called before start", () => {
  const queue = createQueue();
  assert.throws(() => queue.enqueue(1), /start\(\) must be called before enqueue/);
});

test("AiReviewQueue processes items through the handler", async () => {
  const queue = createQueue();
  const processed: number[] = [];

  queue.start(async (item) => {
    processed.push(item);
  });

  queue.enqueue(1);
  queue.enqueue(2);

  // Allow microtasks to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(processed, [1, 2]);
  assert.equal(queue.getStats().totalProcessed, 2);
  assert.equal(queue.getStats().totalEnqueued, 2);
  assert.equal(queue.getStats().depth, 0);
});

test("AiReviewQueue respects concurrency limit", async () => {
  const queue = createQueue({ concurrency: 1 });
  let concurrent = 0;
  let maxConcurrent = 0;

  queue.start(async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent--;
  });

  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);

  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(maxConcurrent, 1);
  assert.equal(queue.getStats().totalProcessed, 3);
});

test("AiReviewQueue allows higher concurrency when configured", async () => {
  const queue = createQueue({ concurrency: 3 });
  let concurrent = 0;
  let maxConcurrent = 0;

  queue.start(async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    concurrent--;
  });

  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(maxConcurrent, 3);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(queue.getStats().totalProcessed, 3);
});

test("AiReviewQueue drops oldest item when at capacity", async () => {
  const queue = createQueue({ capacity: 3, concurrency: 1 });
  const processed: number[] = [];

  // Block the handler so items accumulate.
  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  queue.enqueue(1); // starts processing immediately (blocked)
  queue.enqueue(2); // queued
  queue.enqueue(3); // queued
  queue.enqueue(4); // queued (capacity=3, queue has [2,3,4])
  queue.enqueue(5); // drops 2, queue has [3,4,5]
  queue.enqueue(6); // drops 3, queue has [4,5,6]

  const stats = queue.getStats();
  assert.equal(stats.totalDroppedCapacity, 2);
  assert.equal(stats.totalEnqueued, 6);

  // Unblock the first handler.
  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // First processed item is 1 (was being processed), then 4, 5, 6 (remaining in queue).
  // Item 2 and 3 were dropped.
  assert.deepEqual(processed, [1, 4, 5, 6]);
});

test("AiReviewQueue drops stale items before processing", async () => {
  const queue = createQueue({ socialStalenessMs: 1, concurrency: 1 });
  const processed: number[] = [];

  // Block the first item so subsequent items become stale.
  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  queue.enqueue(1); // starts processing immediately (blocked)
  queue.enqueue(2); // queued

  // Wait for item 2 to become stale (socialStalenessMs=1).
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Unblock the first handler.
  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(processed, [1]);
  assert.equal(queue.getStats().totalDroppedStale, 1);
  assert.equal(queue.getStats().totalProcessed, 1);
});

test("AiReviewQueue.stop() discards pending items", async () => {
  const queue = createQueue({ concurrency: 1 });
  const processed: number[] = [];

  queue.start(async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    processed.push(item);
  });

  queue.enqueue(1); // starts processing
  queue.enqueue(2); // queued
  queue.enqueue(3); // queued

  queue.stop();

  assert.equal(queue.getStats().depth, 0);
  assert.equal(queue.getStats().underPressure, false);

  // Wait for the in-flight item to finish.
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Only the in-flight item (1) should have been processed.
  assert.deepEqual(processed, [1]);
});

test("AiReviewQueue.getStats() returns correct snapshot", () => {
  const queue = createQueue({ capacity: 10 });
  queue.start(async () => {});

  const initial = queue.getStats();
  assert.equal(initial.depth, 0);
  assert.equal(initial.highDepth, 0);
  assert.equal(initial.normalDepth, 0);
  assert.equal(initial.processing, 0);
  assert.equal(initial.totalEnqueued, 0);
  assert.equal(initial.totalProcessed, 0);
  assert.equal(initial.totalDroppedCapacity, 0);
  assert.equal(initial.totalDroppedStale, 0);
  assert.equal(initial.underPressure, false);
});

test("AiReviewQueue handles handler errors without breaking the queue", async () => {
  const queue = createQueue({ concurrency: 1 });
  const processed: number[] = [];

  queue.start(async (item) => {
    if (item === 2) throw new Error("test error");
    processed.push(item);
  });

  queue.enqueue(1);
  queue.enqueue(2); // will throw
  queue.enqueue(3);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(processed, [1, 3]);
  assert.equal(queue.getStats().totalProcessed, 2); // failed item not counted
});

// --- Priority queue tests ---

test("AiReviewQueue processes high-priority items before normal-priority", async () => {
  const queue = createQueue({ concurrency: 1 });
  const processed: number[] = [];

  // Block first item so we can queue up items of both priorities.
  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  queue.enqueue(1);   // normal, starts processing immediately (blocked)
  queue.enqueue(2);   // normal, queued
  queue.enqueue(3);   // normal, queued
  queue.enqueue(200); // high, queued
  queue.enqueue(201); // high, queued

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // High-priority items (200, 201) should process before normal (2, 3).
  assert.deepEqual(processed, [1, 200, 201, 2, 3]);
});

test("AiReviewQueue capacity eviction drops normal items before high items", async () => {
  const queue = createQueue({ capacity: 3, concurrency: 1 });
  const processed: number[] = [];
  const pressureEvents: PressureState[] = [];

  const pressureQueue = new AiReviewQueue<number>(
    { capacity: 3, concurrency: 1, moderationStalenessMs: 0, socialStalenessMs: 30_000 },
    logger,
    (n) => (n > 100 ? "high" : "normal"),
    (state) => pressureEvents.push({ ...state }),
  );

  let unblock: (() => void) | null = null;
  let firstCall = true;

  pressureQueue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  pressureQueue.enqueue(200); // high, starts processing (blocked)
  pressureQueue.enqueue(1);   // normal, queued
  pressureQueue.enqueue(2);   // normal, queued
  pressureQueue.enqueue(201); // high, queued — capacity=3, full
  pressureQueue.enqueue(3);   // over capacity — drops oldest normal (1), not high

  assert.equal(pressureQueue.getStats().totalDroppedCapacity, 1);
  assert.equal(pressureQueue.getStats().normalDepth, 2); // items 2 and 3 (1 was dropped)
  assert.equal(pressureQueue.getStats().highDepth, 1);   // 201

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 200 was processing, then high (201) before normal (2, 3).
  assert.equal(processed[0], 200);
  assert.equal(processed[1], 201);
  assert.ok(pressureEvents.length > 0, "pressure callback should have fired");
});

test("AiReviewQueue drops oldest high item when no normal items remain", async () => {
  const queue = createQueue({
    capacity: 2,
    concurrency: 1,
    classify: () => "high", // everything is high priority
  });

  let unblock: (() => void) | null = null;
  let firstCall = true;
  const processed: number[] = [];

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  queue.enqueue(1); // processing (blocked)
  queue.enqueue(2); // queued
  queue.enqueue(3); // queued — at capacity
  queue.enqueue(4); // drops oldest high (2)

  assert.equal(queue.getStats().totalDroppedCapacity, 1);
  assert.equal(queue.getStats().highDepth, 2);

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(processed, [1, 3, 4]);
});

test("AiReviewQueue never drops high items as stale when moderationStalenessMs is 0", async () => {
  const queue = createQueue({
    concurrency: 1,
    moderationStalenessMs: 0,
    socialStalenessMs: 1,
    classify: (n) => (n > 100 ? "high" : "normal"),
  });
  const processed: number[] = [];

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
    processed.push(item);
  });

  queue.enqueue(1);   // normal, processing (blocked)
  queue.enqueue(200); // high, queued
  queue.enqueue(2);   // normal, queued

  // Wait for socialStalenessMs to expire.
  await new Promise((resolve) => setTimeout(resolve, 20));

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // High item (200) should survive, normal item (2) should be stale-dropped.
  assert.deepEqual(processed, [1, 200]);
  assert.equal(queue.getStats().totalDroppedStale, 1);
});

test("AiReviewQueue fires pressure callback when normal items are dropped", () => {
  const pressureEvents: PressureState[] = [];
  const queue = createQueue({
    capacity: 2,
    onPressure: (state) => pressureEvents.push({ ...state }),
  });

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
  });

  queue.enqueue(1); // processing (blocked)
  queue.enqueue(2); // queued
  queue.enqueue(3); // queued — at capacity

  assert.equal(pressureEvents.length, 0, "no pressure yet");

  queue.enqueue(4); // drops 2 — pressure!

  assert.equal(pressureEvents.length, 1);
  assert.equal(pressureEvents[0]!.underPressure, true);
  assert.equal(pressureEvents[0]!.recentDrops, 1);
});

test("AiReviewQueue defaults to normal priority when classifier throws", async () => {
  const queue = createQueue({
    classify: (n) => {
      if (n === 2) throw new Error("classifier boom");
      return n > 100 ? "high" : "normal";
    },
  });
  const processed: number[] = [];

  queue.start(async (item) => {
    processed.push(item);
  });

  queue.enqueue(1);
  queue.enqueue(2); // classifier throws — defaults to normal
  queue.enqueue(3);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(processed, [1, 2, 3]);
  assert.equal(queue.getStats().normalDepth, 0);
});

test("AiReviewQueue.stop() clears both tiers and resets pressure", () => {
  const queue = createQueue({
    capacity: 2,
    classify: (n) => (n > 100 ? "high" : "normal"),
  });

  let blocked = true;
  queue.start(async () => {
    if (blocked) await new Promise<void>(() => {}); // block forever
  });

  queue.enqueue(1);   // normal, processing (blocked forever)
  queue.enqueue(200); // high, queued
  queue.enqueue(2);   // normal, queued — at capacity
  queue.enqueue(3);   // drops oldest normal (2) — pressure

  assert.equal(queue.getStats().highDepth, 1);
  assert.equal(queue.getStats().normalDepth, 1);
  assert.equal(queue.getStats().underPressure, true);

  queue.stop();

  assert.equal(queue.getStats().highDepth, 0);
  assert.equal(queue.getStats().normalDepth, 0);
  assert.equal(queue.getStats().depth, 0);
  assert.equal(queue.getStats().underPressure, false);
});

// --- Coalescing tests ---

interface CoalesceItem {
  id: number;
  key: string;
  risk: number;
}

function createCoalescingQueue(overrides: {
  capacity?: number;
  concurrency?: number;
  classify?: (item: CoalesceItem) => Priority;
} = {}) {
  return new AiReviewQueue<CoalesceItem>(
    {
      capacity: overrides.capacity ?? 10,
      concurrency: overrides.concurrency ?? 1,
      moderationStalenessMs: 0,
      socialStalenessMs: 30_000,
    },
    logger,
    overrides.classify ?? (() => "high"),
    undefined,
    (item) => item.key,
    (existing, incoming, count): CoalesceResult<CoalesceItem> => {
      const winner = incoming.risk >= existing.risk ? incoming : existing;
      return { merged: winner, count: count + 1 };
    },
  );
}

test("AiReviewQueue coalesces items with the same key", async () => {
  const queue = createCoalescingQueue({ concurrency: 1 });
  const processed: CoalesceItem[] = [];

  // Block first item so subsequent items queue up and coalesce.
  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
    processed.push(item);
  });

  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // starts processing (blocked)
  queue.enqueue({ id: 2, key: "user-a", risk: 0 }); // queued
  queue.enqueue({ id: 3, key: "user-a", risk: 0 }); // coalesces with id=2
  queue.enqueue({ id: 4, key: "user-a", risk: 0 }); // coalesces again

  assert.equal(queue.getStats().depth, 1, "only one queued entry for user-a");
  assert.equal(queue.getStats().totalCoalesced, 2);
  assert.equal(queue.getStats().totalEnqueued, 4);

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(processed.length, 2);
  assert.equal(processed[0]!.id, 1, "first item processed before coalescing");
  // Only 2 items processed despite 4 enqueued — 3 coalesced into 1.
  assert.equal(queue.getStats().totalProcessed, 2);
});

test("AiReviewQueue coalescing keeps the riskier message", async () => {
  const queue = createCoalescingQueue({ concurrency: 1 });
  const processed: CoalesceItem[] = [];

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
    processed.push(item);
  });

  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // processing (blocked)
  queue.enqueue({ id: 2, key: "user-a", risk: 0 }); // queued
  queue.enqueue({ id: 3, key: "user-a", risk: 5 }); // coalesces — riskier, wins
  queue.enqueue({ id: 4, key: "user-a", risk: 1 }); // coalesces — less risky, id=3 stays

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(processed[1]!.id, 3, "riskier message (id=3) wins the coalesce");
});

test("AiReviewQueue does not coalesce items with different keys", async () => {
  const queue = createCoalescingQueue({ concurrency: 1 });
  const processed: CoalesceItem[] = [];

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
    processed.push(item);
  });

  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // processing (blocked)
  queue.enqueue({ id: 2, key: "user-a", risk: 0 }); // queued
  queue.enqueue({ id: 3, key: "user-b", risk: 0 }); // different key, separate entry

  assert.equal(queue.getStats().depth, 2, "two separate entries for different keys");
  assert.equal(queue.getStats().totalCoalesced, 0);

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(processed.length, 3);
});

test("AiReviewQueue does not coalesce with in-flight items", async () => {
  const queue = createCoalescingQueue({ concurrency: 1 });
  const processed: CoalesceItem[] = [];

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
    processed.push(item);
  });

  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // starts processing — removed from queue
  queue.enqueue({ id: 2, key: "user-a", risk: 0 }); // no match in queue, added as new entry

  assert.equal(queue.getStats().depth, 1);
  assert.equal(queue.getStats().totalCoalesced, 0, "in-flight item is not coalesced with");

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(processed.length, 2);
  assert.equal(processed[0]!.id, 1);
  assert.equal(processed[1]!.id, 2);
});

test("AiReviewQueue coalescing promotes normal to high when incoming is high", async () => {
  const queue = createCoalescingQueue({
    concurrency: 1,
    classify: (item) => (item.risk > 3 ? "high" : "normal"),
  });

  let unblock: (() => void) | null = null;
  let firstCall = true;
  const processed: CoalesceItem[] = [];

  queue.start(async (item) => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
    processed.push(item);
  });

  queue.enqueue({ id: 0, key: "blocker", risk: 0 }); // processing (blocked)
  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // normal, queued
  assert.equal(queue.getStats().normalDepth, 1);
  assert.equal(queue.getStats().highDepth, 0);

  queue.enqueue({ id: 2, key: "user-a", risk: 5 }); // high — coalesces and promotes
  assert.equal(queue.getStats().normalDepth, 0, "promoted out of normal tier");
  assert.equal(queue.getStats().highDepth, 1, "promoted into high tier");
  assert.equal(queue.getStats().totalCoalesced, 1);

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // High-priority coalesced item processes before any remaining normal items.
  assert.equal(processed[1]!.id, 2, "riskier message wins");
});

test("AiReviewQueue coalescing skips items with undefined key", async () => {
  const queue = new AiReviewQueue<CoalesceItem>(
    { capacity: 10, concurrency: 1, moderationStalenessMs: 0, socialStalenessMs: 30_000 },
    logger,
    () => "normal",
    undefined,
    () => undefined, // always returns undefined key — no coalescing
    (existing, incoming, count) => ({ merged: incoming, count: count + 1 }),
  );

  let unblock: (() => void) | null = null;
  let firstCall = true;

  queue.start(async () => {
    if (firstCall) {
      firstCall = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
  });

  queue.enqueue({ id: 1, key: "user-a", risk: 0 }); // processing (blocked)
  queue.enqueue({ id: 2, key: "user-a", risk: 0 }); // separate entry (key is undefined)
  queue.enqueue({ id: 3, key: "user-a", risk: 0 }); // separate entry

  assert.equal(queue.getStats().depth, 2, "no coalescing when key is undefined");
  assert.equal(queue.getStats().totalCoalesced, 0);

  unblock!();
  await new Promise((resolve) => setTimeout(resolve, 50));
});
