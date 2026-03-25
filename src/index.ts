import type { EventSubChannelChatMessageEvent, EventSubUserWhisperMessageEvent } from "@twurple/eventsub-base";

import { createAppServices } from "./bootstrap.js";
import { normalizeChatMessage } from "./ingest/normalize-chat-message.js";
import type { WhisperMessage } from "./types.js";

async function main(): Promise<void> {
  const services = await createAppServices();
  const { logger, twitchGateway, runtimeSettings, messageProcessor, controlPlane } = services;
  const settings = runtimeSettings.getEffectiveSettings();

  logger.info(
    {
      dryRun: settings.dryRun,
      broadcaster: twitchGateway.getContext().broadcaster.login,
      bot: twitchGateway.getContext().bot.login,
      aiProvider: settings.provider,
      promptPack: settings.promptPack,
      model: settings.model,
    },
    "starting Twitch AI moderator bot",
  );

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

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down Twitch AI moderator bot");
    await services.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
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
