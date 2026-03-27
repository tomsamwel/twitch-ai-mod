import type { Logger } from "pino";

export interface AiReviewQueueConfig {
  capacity: number;
  concurrency: number;
  stalenessMs: number;
}

export interface AiReviewQueueStats {
  depth: number;
  processing: number;
  totalEnqueued: number;
  totalProcessed: number;
  totalDroppedCapacity: number;
  totalDroppedStale: number;
}

interface QueueEntry<T> {
  data: T;
  enqueuedAt: number;
}

/**
 * Bounded async work queue with concurrency control and staleness eviction.
 *
 * Designed for AI review dispatch in live mode: messages that pass deterministic
 * rules are enqueued here for AI inference. The queue limits concurrent AI calls,
 * drops the oldest item when full, and skips stale items before processing.
 *
 * Generic over `T` so it can be tested with simple data types.
 */
export class AiReviewQueue<T> {
  private readonly items: QueueEntry<T>[] = [];
  private processing = 0;
  private handler: ((item: T) => Promise<void>) | null = null;

  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalDroppedCapacity = 0;
  private totalDroppedStale = 0;

  public constructor(
    private readonly config: AiReviewQueueConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Bind the processing handler. Must be called before enqueue().
   * Uses start() pattern to break circular dependency between queue and MessageProcessor.
   */
  public start(handler: (item: T) => Promise<void>): void {
    this.handler = handler;
  }

  public enqueue(data: T): void {
    if (!this.handler) {
      throw new Error("AiReviewQueue.start() must be called before enqueue()");
    }

    if (this.items.length >= this.config.capacity) {
      this.items.shift();
      this.totalDroppedCapacity++;
      this.logger.warn(
        { depth: this.items.length, capacity: this.config.capacity },
        "AI review queue full, dropped oldest item",
      );
    }

    this.items.push({ data, enqueuedAt: Date.now() });
    this.totalEnqueued++;
    this.drain();
  }

  public getStats(): AiReviewQueueStats {
    return {
      depth: this.items.length,
      processing: this.processing,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDroppedCapacity: this.totalDroppedCapacity,
      totalDroppedStale: this.totalDroppedStale,
    };
  }

  /** In-flight items are not cancelled. */
  public stop(): void {
    const discarded = this.items.length;
    this.items.length = 0;
    if (discarded > 0) {
      this.logger.info({ discarded }, "AI review queue stopped, discarded pending items");
    }
  }

  private drain(): void {
    while (this.processing < this.config.concurrency && this.items.length > 0) {
      const entry = this.items.shift()!;
      const age = Date.now() - entry.enqueuedAt;

      if (age > this.config.stalenessMs) {
        this.totalDroppedStale++;
        this.logger.debug(
          { ageMs: age, stalenessMs: this.config.stalenessMs },
          "dropped stale AI review item",
        );
        continue;
      }

      this.processing++;
      this.handler!(entry.data)
        .catch((err) => this.logger.error({ err }, "AI review handler failed"))
        .finally(() => {
          this.processing--;
          this.totalProcessed++;
          this.drain();
        });
    }
  }
}
