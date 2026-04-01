import { type ApiClient } from "@twurple/api";
import type { EventSubChannelChatMessageEvent, EventSubUserWhisperMessageEvent } from "@twurple/eventsub-base";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import type { RefreshingAuthProvider } from "@twurple/auth";
import type { Logger } from "pino";

import type { ConfigSnapshot, TwitchGatewayContext } from "../types.js";
import { validateTwitchAccessToken } from "./token-validation.js";

export interface SentChatMessage {
  id: string;
  isSent: boolean;
  dropReasonCode?: string;
  dropReasonMessage?: string;
}

export class TwurpleTwitchGateway {
  private readonly listener: EventSubWsListener;
  private validationInterval: NodeJS.Timeout | null = null;
  private started = false;

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
  }

  public getContext(): TwitchGatewayContext {
    return this.context;
  }

  public async start(
    onChatMessage: (event: EventSubChannelChatMessageEvent) => Promise<void>,
    onWhisperMessage?: (event: EventSubUserWhisperMessageEvent) => Promise<void>,
  ): Promise<void> {
    if (this.started) {
      return;
    }

    this.listener.onUserSocketConnect((userId) => {
      this.logger.info({ userId }, "EventSub WebSocket connected");
    });

    this.listener.onUserSocketDisconnect((userId, error) => {
      this.logger.warn({ userId, err: error }, "EventSub WebSocket disconnected");
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
        this.logger.fatal({ err: error }, "Twitch token validation failed; stopping bot");
        if (this.validationInterval) {
          clearInterval(this.validationInterval);
          this.validationInterval = null;
        }
        void this.stop().finally(() => {
          process.exitCode = 1;
        });
      });
    }, intervalMs);
  }
}
