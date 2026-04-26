import type { Logger } from "pino";

import type { SessionChatterTracker, GreetingConfig } from "./session-chatter-tracker.js";

interface ApiClientLike {
  chat: {
    getChatters(broadcasterId: string): Promise<{ data: Array<{ userId: string; userName: string; userDisplayName: string }> }>;
  };
}

interface PollViewer {
  id: string;
  login: string;
  displayName: string;
}

/**
 * Periodically polls the Twitch chatters list to detect new viewers who have
 * not yet sent a message, and enqueues a single batched AI-generated greeting
 * for all newly-detected viewers in one poll cycle.
 *
 * Greetings are de-duplicated via SessionChatterTracker (same tracker used by
 * the first-message greeting path, so no viewer is ever greeted twice within
 * the configured cooldown window).
 */
export class ChatterPollService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly apiClient: ApiClientLike,
    private readonly broadcasterId: string,
    private readonly botUserId: string,
    private readonly tracker: SessionChatterTracker,
    private readonly greetingConfig: GreetingConfig,
    private readonly getQueueDepth: () => number,
    private readonly enqueueGreeting: (viewers: PollViewer[]) => void,
    private readonly isEnabled: () => boolean,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.intervalHandle = setInterval(() => {
      this.poll().catch((err) => this.logger.warn({ err }, "chatter poll failed"));
    }, this.greetingConfig.chatterPollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.isEnabled()) return;

    const nowMs = Date.now();
    let chatters: Awaited<ReturnType<ApiClientLike["chat"]["getChatters"]>>;

    try {
      chatters = await this.apiClient.chat.getChatters(this.broadcasterId);
    } catch (err) {
      this.logger.warn({ err }, "chatter poll: getChatters API call failed");
      return;
    }

    // Filter out the bot and broadcaster so we never greet ourselves.
    const excludeIds = new Set([this.botUserId, this.broadcasterId]);
    const viewers = chatters.data.filter((c) => !excludeIds.has(c.userId));

    const viewerMap = new Map(viewers.map((c) => [c.userId, c]));
    const newlySeenIds = this.tracker.markSeenBulk([...viewerMap.keys()]);

    // Collect all eligible viewers for a single batch greeting.
    const toGreet: PollViewer[] = [];
    for (const id of newlySeenIds) {
      const chatter = viewerMap.get(id);
      if (!chatter) continue;

      if (!this.tracker.shouldGreet(id, nowMs, this.getQueueDepth(), this.greetingConfig)) continue;

      toGreet.push({ id, login: chatter.userName, displayName: chatter.userDisplayName });
    }

    if (toGreet.length === 0) return;

    this.logger.info(
      { count: toGreet.length, viewers: toGreet.map((v) => v.login) },
      "enqueueing batch poll-path AI greeting for new viewers",
    );

    this.enqueueGreeting(toGreet);
  }
}
