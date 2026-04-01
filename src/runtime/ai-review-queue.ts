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
  totalCoalesced: number;
  underPressure: boolean;
}

export interface PressureState {
  underPressure: boolean;
  highDepth: number;
  normalDepth: number;
  recentDrops: number;
}

export interface CoalesceResult<T> {
  /** The winning item to keep in the queue slot. */
  merged: T;
  /** Number of messages now represented by this entry (including the new one). */
  count: number;
}

interface QueueEntry<T> {
  data: T;
  enqueuedAt: number;
  priority: Priority;
  coalesceKey?: string;
  coalescedCount: number;
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
  private totalCoalesced = 0;
  private recentDrops = 0;
  private _underPressure = false;

  public constructor(
    private readonly config: AiReviewQueueConfig,
    private readonly logger: Logger,
    private readonly classify: (item: T) => Priority,
    private readonly onPressure?: (state: PressureState) => void,
    private readonly coalesceKey?: (item: T) => string | undefined,
    private readonly coalesce?: (existing: T, incoming: T, count: number) => CoalesceResult<T>,
  ) {}

  /**
   * Bind the processing handler. Must be called before enqueue().
   * Uses start() pattern to break circular dependency between queue and MessageProcessor.
   *
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

    // Try to coalesce with an existing queued entry for the same key.
    const key = this.coalesceKey?.(data);
    if (key && this.coalesce) {
      const coalesced = this.tryCoalesce(key, data, priority);
      if (coalesced) {
        this.totalEnqueued++;
        this.totalCoalesced++;
        this.drain();
        return;
      }
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

    const entry: QueueEntry<T> = { data, enqueuedAt: Date.now(), priority, ...(key ? { coalesceKey: key } : {}), coalescedCount: 1 };
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
      totalCoalesced: this.totalCoalesced,
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

  /**
   * Search both tiers for a queued entry with the same coalesce key.
   * If found, merge the incoming item into it and return true.
   */
  private tryCoalesce(key: string, data: T, incomingPriority: Priority): boolean {
    const entry = this.findByCoalesceKey(key);
    if (!entry) return false;

    const result = this.coalesce!(entry.data, data, entry.coalescedCount);
    entry.data = result.merged;
    entry.coalescedCount = result.count;

    // Promote normal → high if the incoming item is higher priority.
    if (entry.priority === "normal" && incomingPriority === "high") {
      const idx = this.normalItems.indexOf(entry);
      if (idx !== -1) {
        this.normalItems.splice(idx, 1);
        entry.priority = "high";
        this.highItems.push(entry);
      }
    }

    this.logger.debug(
      { coalesceKey: key, coalescedCount: entry.coalescedCount },
      "coalesced AI review queue item",
    );
    return true;
  }

  private findByCoalesceKey(key: string): QueueEntry<T> | undefined {
    for (const entry of this.highItems) {
      if (entry.coalesceKey === key) return entry;
    }
    for (const entry of this.normalItems) {
      if (entry.coalesceKey === key) return entry;
    }
    return undefined;
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
