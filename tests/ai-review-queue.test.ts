import assert from "node:assert/strict";
import test from "node:test";

import { AiReviewQueue } from "../src/runtime/ai-review-queue.js";
import { createLogger } from "../src/storage/logger.js";

const logger = createLogger("error", "test");

function createQueue(overrides: { capacity?: number; concurrency?: number; stalenessMs?: number } = {}) {
  return new AiReviewQueue<number>(
    {
      capacity: overrides.capacity ?? 5,
      concurrency: overrides.concurrency ?? 1,
      stalenessMs: overrides.stalenessMs ?? 30_000,
    },
    logger,
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
  const queue = createQueue({ stalenessMs: 1, concurrency: 1 });
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

  // Wait for item 2 to become stale (stalenessMs=1).
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
  assert.equal(initial.processing, 0);
  assert.equal(initial.totalEnqueued, 0);
  assert.equal(initial.totalProcessed, 0);
  assert.equal(initial.totalDroppedCapacity, 0);
  assert.equal(initial.totalDroppedStale, 0);
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
  assert.equal(queue.getStats().totalProcessed, 3);
});
