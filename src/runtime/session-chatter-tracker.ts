export interface GreetingConfig {
  maxQueueDepth: number;
  rateLimitMs: number;
  greetingCooldownMs: number;
  chatterPollIntervalMs: number;
}

export interface GreetingPersistence {
  isRecentlyGreeted(userId: string, windowMs: number): boolean;
  recordGreeted(userId: string): void;
}

/**
 * Tracks which chatters have been seen and greeted.
 * - `seen` is in-memory (resets on restart) -- used for first-message detection.
 * - Greeting de-duplication is DB-backed via GreetingPersistence so it
 *   survives restarts and uses a time-based cooldown window.
 */
export class SessionChatterTracker {
  private readonly seen = new Set<string>();
  private readonly messageSeen = new Set<string>();
  private lastGreetingMs = 0;

  constructor(
    private readonly persistence?: GreetingPersistence,
  ) {}

  /**
   * Mark a chatter as seen. Returns true if this is their first appearance
   * this session, false if they've been seen before.
   */
  markSeen(chatterId: string): boolean {
    if (this.seen.has(chatterId)) return false;
    this.seen.add(chatterId);
    return true;
  }

  /**
   * Returns true if this is the chatter's first chat message this session.
   * Separate from markSeen/markSeenBulk (used by the poll) so the poll
   * doesn't steal first-message status.
   */
  isFirstMessage(chatterId: string): boolean {
    if (this.messageSeen.has(chatterId)) return false;
    this.messageSeen.add(chatterId);
    return true;
  }

  /**
   * Bulk-mark multiple chatters as seen (from a chatters-list poll).
   * Returns the IDs that are newly seen this session.
   */
  markSeenBulk(chatterIds: string[]): string[] {
    return chatterIds.filter((id) => this.markSeen(id));
  }

  /**
   * Check whether a greeting should be sent right now.
   * Returns false if: recently greeted (DB-backed cooldown), queue too busy,
   * or global rate limit active.
   */
  shouldGreet(chatterId: string, nowMs: number, queueDepth: number, config: GreetingConfig): boolean {
    if (this.persistence?.isRecentlyGreeted(chatterId, config.greetingCooldownMs)) return false;
    if (queueDepth > config.maxQueueDepth) return false;
    if (nowMs - this.lastGreetingMs < config.rateLimitMs) return false;
    return true;
  }

  /** Record that a chatter has been greeted, updating the rate-limit timestamp. */
  markGreeted(chatterId: string, nowMs: number): void {
    this.persistence?.recordGreeted(chatterId);
    this.lastGreetingMs = nowMs;
  }
}
