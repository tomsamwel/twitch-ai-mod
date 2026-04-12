import { type ApiClient } from "@twurple/api";
import type { EventSubChannelChatMessageEvent, EventSubUserWhisperMessageEvent } from "@twurple/eventsub-base";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import type { RefreshingAuthProvider } from "@twurple/auth";
import type { Logger } from "pino";

import type { ConfigSnapshot, EventSubConnectionStatus, TwitchGatewayContext } from "../types.js";
import { validateTwitchAccessToken } from "./token-validation.js";
import { EventSubConnectionMonitor } from "./eventsub-connection-monitor.js";

export interface SentChatMessage {
  id: string;
  isSent: boolean;
  dropReasonCode?: string;
  dropReasonMessage?: string;
}

export interface TwitchGatewayFatalFailure {
  kind: "eventsub-stalled" | "token-validation-failed";
  error?: Error;
  connectionStatus: EventSubConnectionStatus;
}

export class TwurpleTwitchGateway {
  private readonly listener: EventSubWsListener;
  private readonly connectionMonitor: EventSubConnectionMonitor;
  private validationInterval: NodeJS.Timeout | null = null;
  private started = false;
  private fatalFailureNotified = false;
  private fatalFailureHandler: ((failure: TwitchGatewayFatalFailure) => void | Promise<void>) | null = null;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
    private readonly apiClient: ApiClient,
    private readonly authProvider: RefreshingAuthProvider,
    private readonly context: TwitchGatewayContext,
  ) {
    this.listener = new EventSubWsListener({
      apiClient: this.apiClient,
    });
    this.connectionMonitor = new EventSubConnectionMonitor(
      this.config.runtime.eventSubDisconnectGraceSeconds,
      this.config.runtime.exitOnEventSubStall,
      (status) => {
        if (!status.exitOnStall) {
          this.logger.error(
            { connectionStatus: status },
            "EventSub WebSocket remained disconnected past the grace period",
          );
          return;
        }

        this.logger.fatal(
          { connectionStatus: status },
          "EventSub WebSocket remained disconnected past the grace period; requesting shutdown",
        );
        this.notifyFatalFailure({
          kind: "eventsub-stalled",
          connectionStatus: status,
          ...(status.lastDisconnectError ? { error: new Error(status.lastDisconnectError) } : {}),
        });
      },
    );
  }

  public getContext(): TwitchGatewayContext {
    return this.context;
  }

  public setFatalFailureHandler(
    handler: (failure: TwitchGatewayFatalFailure) => void | Promise<void>,
  ): void {
    this.fatalFailureHandler = handler;
  }

  public getConnectionStatus(): EventSubConnectionStatus {
    return this.connectionMonitor.getStatus();
  }

  public async start(
    onChatMessage: (event: EventSubChannelChatMessageEvent) => Promise<void>,
    onWhisperMessage?: (event: EventSubUserWhisperMessageEvent) => Promise<void>,
  ): Promise<void> {
    if (this.started) {
      return;
    }

    this.listener.onUserSocketConnect((userId) => {
      const { reconnectedAfterMs } = this.connectionMonitor.markConnected();
      this.logger.info(
        {
          userId,
          ...(reconnectedAfterMs !== null ? { reconnectedAfterMs } : {}),
        },
        "EventSub WebSocket connected",
      );
    });

    this.listener.onUserSocketDisconnect((userId, error) => {
      this.connectionMonitor.markDisconnected(error);
      this.logger.warn(
        {
          userId,
          err: error,
          reconnectGraceSeconds: this.config.runtime.eventSubDisconnectGraceSeconds,
          exitOnStall: this.config.runtime.exitOnEventSubStall,
        },
        "EventSub WebSocket disconnected",
      );
    });

    this.listener.onSubscriptionCreateFailure((subscription, error) => {
      this.logger.error(
        {
          err: error,
          subscriptionId: subscription.id,
        },
        "failed to create EventSub subscription",
      );
    });

    this.listener.onRevoke((subscription, status) => {
      this.logger.warn(
        {
          subscriptionId: subscription.id,
          status,
        },
        "EventSub subscription revoked",
      );
    });

    this.listener.start();
    const chatSub = this.listener.onChannelChatMessage(
      this.context.broadcaster.id,
      this.context.bot.id,
      (event) => {
        void onChatMessage(event).catch((error) => {
          this.logger.error({ err: error, messageId: event.messageId }, "failed to process chat message");
        });
      },
    );
    this.logger.info(
      { broadcasterId: this.context.broadcaster.id, botId: this.context.bot.id },
      "subscribing to channel.chat.message",
    );

    if (onWhisperMessage) {
      this.listener.onUserWhisperMessage(this.context.bot.id, (event) => {
        void onWhisperMessage(event).catch((error) => {
          this.logger.error({ err: error, whisperId: event.id }, "failed to process whisper message");
        });
      });
      this.logger.info(
        { botId: this.context.bot.id },
        "subscribing to user.whisper.message",
      );
    }

    await this.validateCurrentToken();
    this.startValidationLoop();
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.connectionMonitor.stop();

    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }

    if (this.started) {
      this.listener.stop();
      this.started = false;
    }
  }

  public async validateCurrentToken(): Promise<void> {
    const token = await this.authProvider.getAccessTokenForUser(
      this.context.bot.id,
      this.config.twitch.requiredScopes,
    );

    if (!token) {
      throw new Error("Unable to load bot access token for validation.");
    }

    const validated = await validateTwitchAccessToken(token.accessToken);
    this.logger.debug(
      {
        userId: validated.userId,
        login: validated.login,
        scopes: validated.scopes,
        expiresIn: validated.expiresIn,
      },
      "validated Twitch token",
    );
  }

  public async sendChatMessage(message: string, replyParentMessageId?: string): Promise<SentChatMessage> {
    return this.apiClient.asUser(this.context.bot.id, async (ctx) => {
      const result = await ctx.chat.sendChatMessage(this.context.broadcaster.id, message, {
        ...(replyParentMessageId ? { replyParentMessageId } : {}),
      });

      if (!result.isSent) {
        this.logger.warn(
          { dropReasonCode: result.dropReasonCode, dropReasonMessage: result.dropReasonMessage },
          "Twitch API accepted chat message but did not send it",
        );
      }

      return {
        id: result.id,
        isSent: result.isSent,
        ...(result.dropReasonCode ? { dropReasonCode: result.dropReasonCode } : {}),
        ...(result.dropReasonMessage ? { dropReasonMessage: result.dropReasonMessage } : {}),
      };
    });
  }

  public async timeoutUser(userId: string, durationSeconds: number, reason: string): Promise<void> {
    await this.apiClient.asUser(this.context.bot.id, async (ctx) => {
      await ctx.moderation.banUser(this.context.broadcaster.id, {
        user: userId,
        duration: durationSeconds,
        reason,
      });
    });
  }

  public async sendWhisper(targetUserId: string, message: string): Promise<void> {
    await this.apiClient.asUser(this.context.bot.id, async (ctx) => {
      await ctx.whispers.sendWhisper(this.context.bot.id, targetUserId, message);
    });
  }

  private startValidationLoop(): void {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }

    const intervalMs = this.config.runtime.tokenValidationIntervalMinutes * 60 * 1000;
    this.validationInterval = setInterval(() => {
      void this.validateCurrentToken().catch((error) => {
        this.logger.fatal({ err: error }, "Twitch token validation failed; requesting shutdown");
        if (this.validationInterval) {
          clearInterval(this.validationInterval);
          this.validationInterval = null;
        }
        this.notifyFatalFailure({
          kind: "token-validation-failed",
          error: error instanceof Error ? error : new Error(String(error)),
          connectionStatus: this.connectionMonitor.getStatus(),
        });
      });
    }, intervalMs);
  }

  private notifyFatalFailure(failure: TwitchGatewayFatalFailure): void {
    if (this.fatalFailureNotified) {
      return;
    }

    this.fatalFailureNotified = true;
    void this.fatalFailureHandler?.(failure);
  }
}
