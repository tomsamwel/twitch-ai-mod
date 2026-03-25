export class OutboundMessageTracker {
  private readonly messageIds = new Map<string, number>();

  public constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  public note(messageId: string, now = Date.now()): void {
    this.prune(now);
    this.messageIds.set(messageId, now);
  }

  public consume(messageId: string, now = Date.now()): boolean {
    this.prune(now);

    if (!this.messageIds.has(messageId)) {
      return false;
    }

    this.messageIds.delete(messageId);
    return true;
  }

  private prune(now: number): void {
    for (const [messageId, createdAt] of this.messageIds.entries()) {
      if (now - createdAt > this.ttlMs) {
        this.messageIds.delete(messageId);
      }
    }
  }
}
