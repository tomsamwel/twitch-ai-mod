import type { Logger } from "pino";

export type Priority = "high" | "normal";

export interface AiReviewQueueConfig {
  capacity: number;
  concurrency: number;
  moderationStalenessMs: number;
  socialStalenessMs: number;
}

export interface AiReviewQueueStats {
  highDepth: number;
  normalDepth: number;
  depth: number;
  processing: number;
  totalEnqueued: number;
  totalProcessed: number;
  totalDroppedCapacity: number;
  totalDroppedStale: number;
  underPressure: boolean;
}

export interface PressureState {
  underPressure: boolean;
  highDepth: number;
  normalDepth: number;
  recentDrops: number;
}

interface QueueEntry<T> {
  data: T;
  enqueuedAt: number;
  priority: Priority;
}

/**
 * Bounded two-tier priority queue with concurrency control and per-tier staleness.
 *
 * High-priority items (moderation) always drain before normal-priority items (social).
 * When at capacity, normal items are evicted first. Staleness thresholds are per-tier:
 * moderation items can be configured to never go stale (threshold 0).
 *
 * Generic over `T` so it can be tested with simple data types.
 */
export class AiReviewQueue<T> {
  private readonly highItems: QueueEntry<T>[] = [];
  private readonly normalItems: QueueEntry<T>[] = [];
  private processing = 0;
  private handler: ((item: T) => Promise<void>) | null = null;

  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalDroppedCapacity = 0;
  private totalDroppedStale = 0;
  private recentDrops = 0;
  private _underPressure = false;

  public constructor(
    private readonly config: AiReviewQueueConfig,
    private readonly logger: Logger,
    private readonly classify: (item: T) => Priority,
    private readonly onPressure?: (state: PressureState) => void,
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

    let priority: Priority;
    try {
      priority = this.classify(data);
    } catch (err) {
      this.logger.error({ err }, "AI review queue classifier failed, defaulting to normal");
      priority = "normal";
    }

    const totalDepth = this.highItems.length + this.normalItems.length;
    if (totalDepth >= this.config.capacity) {
      if (this.normalItems.length > 0) {
        this.normalItems.shift();
        this.recordDrop("capacity", "normal");
      } else {
        this.highItems.shift();
        this.recordDrop("capacity", "high");
      }
    }

    const entry: QueueEntry<T> = { data, enqueuedAt: Date.now(), priority };
    if (priority === "high") {
      this.highItems.push(entry);
    } else {
      this.normalItems.push(entry);
    }
    this.totalEnqueued++;
    this.drain();
  }

  public getStats(): AiReviewQueueStats {
    return {
      highDepth: this.highItems.length,
      normalDepth: this.normalItems.length,
      depth: this.highItems.length + this.normalItems.length,
      processing: this.processing,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDroppedCapacity: this.totalDroppedCapacity,
      totalDroppedStale: this.totalDroppedStale,
      underPressure: this._underPressure,
    };
  }

  /** In-flight items are not cancelled. */
  public stop(): void {
    const discarded = this.highItems.length + this.normalItems.length;
    this.highItems.length = 0;
    this.normalItems.length = 0;
    this.recentDrops = 0;
    this._underPressure = false;
    if (discarded > 0) {
      this.logger.info({ discarded }, "AI review queue stopped, discarded pending items");
    }
  }

  private recordDrop(reason: "capacity" | "stale", tier: Priority): void {
    if (reason === "capacity") {
      this.totalDroppedCapacity++;
    } else {
      this.totalDroppedStale++;
    }

    this.logger.warn(
      { depth: this.highItems.length + this.normalItems.length, capacity: this.config.capacity, reason, droppedTier: tier },
      `AI review queue dropped ${tier}-priority item`,
    );

    if (tier === "normal") {
      this.recentDrops++;
      this._underPressure = true;
      this.emitPressure();
    }
  }

  private emitPressure(): void {
    if (!this.onPressure) return;
    this.onPressure({
      underPressure: true,
      highDepth: this.highItems.length,
      normalDepth: this.normalItems.length,
      recentDrops: this.recentDrops,
    });
  }

  private stalenessForPriority(priority: Priority): number {
    return priority === "high"
      ? this.config.moderationStalenessMs
      : this.config.socialStalenessMs;
  }

  private drain(): void {
    while (this.processing < this.config.concurrency && (this.highItems.length > 0 || this.normalItems.length > 0)) {
      const source = this.highItems.length > 0 ? this.highItems : this.normalItems;
      const entry = source.shift()!;
      const age = Date.now() - entry.enqueuedAt;
      const stalenessMs = this.stalenessForPriority(entry.priority);

      if (stalenessMs > 0 && age > stalenessMs) {
        this.recordDrop("stale", entry.priority);
        continue;
      }

      this.processing++;
      this.handler!(entry.data)
        .catch((err) => this.logger.error({ err }, "AI review handler failed"))
        .finally(() => {
          this.processing--;
          this.totalProcessed++;
          if (this._underPressure && this.highItems.length === 0 && this.normalItems.length === 0) {
            this._underPressure = false;
            this.recentDrops = 0;
          }
          this.drain();
        });
    }
  }
}
