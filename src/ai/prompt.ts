import { aiDecisionJsonSchema } from "./decision-schema.js";
import type {
  AiContextSnapshot,
  AiDecisionInput,
  AiMode,
  AiPromptPayload,
  ConfigSnapshot,
  NormalizedChatMessage,
  TwitchIdentity,
} from "../types.js";

interface AiModeSignals {
  mode: AiMode;
  mentionedBot: boolean;
  textualMention: boolean;
  repliedToBot: boolean;
  threadedWithBot: boolean;
  rewardTriggered: boolean;
  broadcasterAddressed: boolean;
}

export interface AiModeSelection {
  mode: AiMode;
  signals: AiModeSignals;
}

function detectAiModeSignals(
  message: NormalizedChatMessage,
  botIdentity: TwitchIdentity,
  config: ConfigSnapshot,
): AiModeSignals {
  const mentionedBot = message.parts.some((part) => {
    if (part.type !== "mention") {
      return false;
    }

    return (
      part.mentionUserId === botIdentity.id ||
      part.mentionUserLogin?.toLowerCase() === botIdentity.login.toLowerCase()
    );
  });

  const lowerText = message.text.toLowerCase();
  const textualMention = lowerText.includes(`@${botIdentity.login.toLowerCase()}`);
  const repliedToBot = message.replyParentUserId === botIdentity.id;
  const threadedWithBot = message.threadMessageUserId === botIdentity.id;
  const rewardTriggered = message.isRedemption;
  const broadcasterAddressed =
    message.parts.some(
      (part) =>
        part.type === "mention" &&
        part.mentionUserLogin?.toLowerCase() === config.twitch.broadcasterLogin.toLowerCase(),
    ) || lowerText.includes(`@${config.twitch.broadcasterLogin.toLowerCase()}`);

  return {
    mode:
      mentionedBot || textualMention || repliedToBot || threadedWithBot || rewardTriggered || broadcasterAddressed
        ? "social"
        : "moderation",
    mentionedBot,
    textualMention,
    repliedToBot,
    threadedWithBot,
    rewardTriggered,
    broadcasterAddressed,
  };
}

export function selectAiMode(
  message: NormalizedChatMessage,
  botIdentity: TwitchIdentity,
  config: ConfigSnapshot,
): AiModeSelection {
  const signals = detectAiModeSignals(message, botIdentity, config);
  return {
    mode: signals.mode,
    signals,
  };
}

export function composeAiPrompt(
  message: NormalizedChatMessage,
  config: ConfigSnapshot,
  mode: AiMode,
  botIdentity: TwitchIdentity,
  signals: AiModeSignals,
  context: AiContextSnapshot,
): AiPromptPayload {
  const modePrompt =
    mode === "social" ? config.prompts.socialPersona.trim() : config.prompts.moderation.trim();

  const roomContextBlock =
    context.recentRoomMessages.length > 0
      ? context.recentRoomMessages
          .map(
            (entry) =>
              `- [${entry.receivedAt}] @${entry.chatterLogin}${entry.isBotMessage ? " (bot)" : ""}: ${entry.text}`,
          )
          .join("\n")
      : "- none";
  const userHistoryBlock =
    context.recentUserMessages.length > 0
      ? context.recentUserMessages
          .map((entry) => `- [${entry.receivedAt}] @${entry.chatterLogin}: ${entry.text}`)
          .join("\n")
      : "- none";
  const botInteractionBlock =
    context.recentBotInteractions.length > 0
      ? context.recentBotInteractions
          .map((entry) => {
            const details =
              entry.kind === "say"
                ? entry.message
                  ? `message="${entry.message}"`
                  : "message=<none>"
                : `durationSeconds=${entry.durationSeconds ?? "default"}`;

            return `- [${entry.createdAt}] ${entry.kind} status=${entry.status} source=${entry.source} ${details} reason="${entry.reason}"`;
          })
          .join("\n")
      : "- none";

  const system = [
    config.prompts.system.trim(),
    modePrompt,
    config.prompts.responseStyle.trim(),
    config.prompts.safetyRules.trim(),
    [
      "Decision instructions:",
      "- Deterministic rules already ran and did not take action for this message.",
      "- Return only valid JSON, with no markdown and no explanation outside the JSON object.",
      "- Prefer abstaining when confidence is low.",
      "- The current mode is already decided by the application. Echo that exact mode in the mode field.",
      "- If outcome is abstain, actions must be [].",
      "- Use at most one action.",
      "- Allowed action kinds are say and timeout.",
      "- If you choose say, provide a short chat-safe message.",
      "- If you choose timeout, you may omit targetUserId, targetUserName, and durationSeconds to apply defaults to the current chatter.",
      "- Do not include placeholder or contradictory actions.",
      "- If current mode is social and the message directly addresses the bot with a clear question or help request, prefer one short say reply over abstaining.",
      "- If the broadcaster login and bot login are the same, mentions of the channel handle also count as direct bot mentions.",
      '- Valid abstain example: {"outcome":"abstain","reason":"no intervention needed","confidence":0.9,"mode":"moderation","actions":[]}.',
      '- Valid say example: {"outcome":"action","reason":"brief clarification helps","confidence":0.7,"mode":"social","actions":[{"kind":"say","reason":"short helpful reply","message":"I only step in when it helps chat."}]}.',
    ].join("\n"),
  ].join("\n\n");

  const user = [
    `Current mode: ${mode}`,
    `Bot identity: @${botIdentity.login}`,
    `Channel: @${config.twitch.broadcasterLogin}`,
    "Current message context:",
    JSON.stringify(
      {
        eventId: message.eventId,
        chatterId: message.chatterId,
        chatterLogin: message.chatterLogin,
        chatterDisplayName: message.chatterDisplayName,
        text: message.text,
        messageType: message.messageType,
        badges: message.badges,
        roles: message.roles,
        isReply: message.isReply,
        isCheer: message.isCheer,
        bits: message.bits,
        isRedemption: message.isRedemption,
        rewardId: message.rewardId,
      },
      null,
      2,
    ),
    "Mode trigger signals:",
    JSON.stringify(signals, null, 2),
    "Recent room context:",
    roomContextBlock,
    "Recent same-user history:",
    userHistoryBlock,
    "Recent bot interactions toward this user:",
    botInteractionBlock,
    "Moderation policy snapshot:",
    JSON.stringify(config.moderationPolicy, null, 2),
    "Required JSON schema:",
    JSON.stringify(aiDecisionJsonSchema, null, 2),
    [
      "Mode guidance:",
      mode === "social"
        ? "- In social mode, the bot was directly addressed or otherwise invited in. Prefer one brief helpful say reply when a clear question or help request is present."
        : "- In moderation mode, prefer abstain or a timeout only when intervention is useful.",
    ].join("\n"),
  ].join("\n\n");

  return { system, user };
}

export function buildAiDecisionInput(
  message: NormalizedChatMessage,
  context: AiContextSnapshot,
  config: ConfigSnapshot,
  botIdentity: TwitchIdentity,
  selection = selectAiMode(message, botIdentity, config),
): AiDecisionInput {
  return {
    mode: selection.mode,
    message,
    context,
    config,
    prompt: composeAiPrompt(message, config, selection.mode, botIdentity, selection.signals, context),
  };
}
