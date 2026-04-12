import type { Logger } from "pino";

export type Priority = "high" | "normal" | "low";

export interface AiReviewQueueConfig {
  capacity: number;
  concurrency: number;
  moderationStalenessMs: number;
  socialStalenessMs: number;
}

export interface AiReviewQueueStats {
  highDepth: number;
  normalDepth: number;
  lowDepth: number;
  depth: number;
  processing: number;
  totalEnqueued: number;
  totalProcessed: number;
  totalErrors: number;
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
 * Three-tier priority queue: high (moderation) > normal (social + first-message greetings) > low (poll greetings).
 * When at capacity, low items are evicted first, then normal, then high.
 * Staleness thresholds are per-tier: moderation items can be configured to never go stale (threshold 0).
 *
 * Generic over `T` so it can be tested with simple data types.
 */
export class AiReviewQueue<T> {
  private readonly highItems: QueueEntry<T>[] = [];
  private readonly normalItems: QueueEntry<T>[] = [];
  private readonly lowItems: QueueEntry<T>[] = [];
  private get totalDepth(): number {
    return this.highItems.length + this.normalItems.length + this.lowItems.length;
  }
  private processing = 0;
  private handler: ((item: T) => Promise<void>) | null = null;
  private stopped = false;

  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalErrors = 0;
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
    if (this.stopped) return;
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

    const totalDepth = this.totalDepth;
    if (totalDepth >= this.config.capacity) {
      if (this.lowItems.length > 0) {
        this.lowItems.shift();
        this.recordDrop("capacity", "low");
      } else if (this.normalItems.length > 0) {
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
    } else if (priority === "normal") {
      this.normalItems.push(entry);
    } else {
      this.lowItems.push(entry);
    }
    this.totalEnqueued++;
    this.drain();
  }

  public getStats(): AiReviewQueueStats {
    return {
      highDepth: this.highItems.length,
      normalDepth: this.normalItems.length,
      lowDepth: this.lowItems.length,
      depth: this.totalDepth,
      processing: this.processing,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      totalDroppedCapacity: this.totalDroppedCapacity,
      totalDroppedStale: this.totalDroppedStale,
      totalCoalesced: this.totalCoalesced,
      underPressure: this._underPressure,
    };
  }

  /** In-flight items are not cancelled. */
  public stop(): void {
    this.stopped = true;
    const discarded = this.totalDepth;
    this.highItems.length = 0;
    this.normalItems.length = 0;
    this.lowItems.length = 0;
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

    // Promote to higher priority tier if incoming item has higher priority.
    const tierRank = { high: 2, normal: 1, low: 0 } as const;
    if (tierRank[incomingPriority] > tierRank[entry.priority]) {
      const sourceList = entry.priority === "normal" ? this.normalItems : this.lowItems;
      const targetList = incomingPriority === "high" ? this.highItems : this.normalItems;
      const idx = sourceList.indexOf(entry);
      if (idx !== -1) {
        sourceList.splice(idx, 1);
        entry.priority = incomingPriority;
        targetList.push(entry);
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
    for (const entry of this.lowItems) {
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
      { depth: this.totalDepth, capacity: this.config.capacity, reason, droppedTier: tier },
      `AI review queue dropped ${tier}-priority item`,
    );

    if (tier === "normal" || tier === "low") {
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
    if (priority === "high") return this.config.moderationStalenessMs;
    return this.config.socialStalenessMs;
  }

  private nextSource(): QueueEntry<T>[] | null {
    if (this.highItems.length > 0) return this.highItems;
    if (this.normalItems.length > 0) return this.normalItems;
    if (this.lowItems.length > 0) return this.lowItems;
    return null;
  }

  private drain(): void {
    let source: QueueEntry<T>[] | null;
    while (this.processing < this.config.concurrency && (source = this.nextSource()) !== null) {
      const entry = source.shift()!;
      const age = Date.now() - entry.enqueuedAt;
      const stalenessMs = this.stalenessForPriority(entry.priority);

      if (stalenessMs > 0 && age > stalenessMs) {
        this.recordDrop("stale", entry.priority);
        continue;
      }

      this.processing++;
      this.handler!(entry.data)
        .then(() => { this.totalProcessed++; })
        .catch((err) => {
          this.totalErrors++;
          this.logger.error({ err }, "AI review handler failed");
        })
        .finally(() => {
          this.processing--;
          const depth = this.totalDepth;
          if (this._underPressure && depth < this.config.capacity / 2) {
            this._underPressure = false;
            this.recentDrops = 0;
          }
          this.drain();
        });
    }
  }
}
