import type { EventSubChannelChatMessageEvent, EventSubUserWhisperMessageEvent } from "@twurple/eventsub-base";

import { createAppServices } from "./bootstrap.js";
import { normalizeChatMessage } from "./ingest/normalize-chat-message.js";
import type { WhisperMessage } from "./types.js";

async function main(): Promise<void> {
  const services = await createAppServices();
  const { logger, twitchGateway, runtimeSettings, messageProcessor, controlPlane } = services;
  const settings = runtimeSettings.getEffectiveSettings();
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal, exitCode }, "shutting down Twitch AI moderator bot");
    const forceExit = setTimeout(() => {
      logger.fatal("graceful shutdown timed out after 10s, forcing exit");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    await services.close();
    process.exit(exitCode);
  };

  logger.info(
    {
      gates: {
        rules: settings.rules.enabled,
        ai: settings.ai.enabled,
        social: settings.ai.social.enabled,
        moderation: settings.ai.moderation.enabled,
        warn: settings.ai.moderation.warn,
        timeout: settings.ai.moderation.timeout,
      },
      broadcaster: twitchGateway.getContext().broadcaster.login,
      bot: twitchGateway.getContext().bot.login,
      aiProvider: settings.provider,
      promptPack: settings.promptPack,
      model: settings.model,
    },
    "starting Twitch AI moderator bot",
  );

  twitchGateway.setFatalFailureHandler(async (failure) => {
    logger.fatal(
      {
        failureKind: failure.kind,
        err: failure.error,
        connectionStatus: failure.connectionStatus,
      },
      "Twitch gateway entered unrecoverable state",
    );
    await shutdown(`gateway:${failure.kind}`, 1);
  });

  await twitchGateway.start(
    async (event: EventSubChannelChatMessageEvent) => {
      const message = normalizeChatMessage(event);
      await messageProcessor.process(message, {
        botIdentity: twitchGateway.getContext().bot,
        processingMode: "live",
        dedupe: true,
        persistSnapshot: true,
      });
    },
    controlPlane
      ? async (event: EventSubUserWhisperMessageEvent) => {
          await controlPlane.processWhisper(normalizeWhisperMessage(event));
        }
      : undefined,
  );

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
}

function normalizeWhisperMessage(event: EventSubUserWhisperMessageEvent): WhisperMessage {
  return {
    id: event.id,
    receivedAt: new Date().toISOString(),
    recipientUserId: event.userId,
    recipientUserLogin: event.userName,
    recipientUserDisplayName: event.userDisplayName,
    senderUserId: event.senderUserId,
    senderUserLogin: event.senderUserName,
    senderUserDisplayName: event.senderUserDisplayName,
    text: event.messageText,
  };
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
