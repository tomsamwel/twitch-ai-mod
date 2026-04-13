import type { ChatMessageEventLike, NormalizedChatMessage, NormalizedMessagePart } from "../types.js";
import { detectUrls } from "../moderation/url-detect.js";
import { normalizeUnicode } from "../moderation/unicode-normalize.js";

function deriveRoles(badges: Record<string, string>): string[] {
  const roles: string[] = [];

  if (badges.broadcaster) {
    roles.push("broadcaster");
  }

  if (badges.moderator) {
    roles.push("moderator");
  }

  if (badges.vip) {
    roles.push("vip");
  }

  if (badges.subscriber) {
    roles.push("subscriber");
  }

  if (badges.staff || badges.admin || badges.global_mod) {
    roles.push("trusted");
  }

  if (roles.length === 0) {
    roles.push("viewer");
  }

  return roles;
}

function normalizeParts(message: ChatMessageEventLike): NormalizedMessagePart[] {
  return message.messageParts.map((part) => {
    switch (part.type) {
      case "text":
        return {
          type: "text",
          text: part.text,
        };
      case "mention":
        return {
          type: "mention",
          text: part.text,
          mentionUserId: part.mention.user_id,
          mentionUserLogin: part.mention.user_login,
          mentionUserName: part.mention.user_name,
        };
      case "cheermote":
        return {
          type: "cheermote",
          text: part.text,
          bits: part.cheermote.bits,
        };
      case "emote":
        return {
          type: "emote",
          text: part.text,
          emoteId: part.emote.id,
        };
    }
  });
}

export function normalizeChatMessage(
  message: ChatMessageEventLike,
  receivedAt = new Date(),
): NormalizedChatMessage {
  const text = message.messageText;
  const normalizedText = normalizeUnicode(text);
  const urlResult = detectUrls(normalizedText ?? text);
  const roles = deriveRoles(message.badges);
  const isPrivileged =
    roles.includes("broadcaster") || roles.includes("moderator") || roles.includes("vip") || roles.includes("trusted");

  return {
    eventId: message.messageId,
    sourceMessageId: message.messageId,
    receivedAt: receivedAt.toISOString(),
    broadcasterId: message.broadcasterId,
    broadcasterLogin: message.broadcasterName,
    broadcasterDisplayName: message.broadcasterDisplayName,
    chatterId: message.chatterId,
    chatterLogin: message.chatterName,
    chatterDisplayName: message.chatterDisplayName,
    text,
    normalizedText,
    urlResult: {
      detected: urlResult.detected,
      urls: urlResult.urls,
    },
    color: message.color,
    messageType: message.messageType,
    badges: message.badges,
    roles,
    isPrivileged,
    isReply: message.parentMessageId !== null,
    replyParentMessageId: message.parentMessageId,
    replyParentUserId: message.parentMessageUserId,
    replyParentUserLogin: message.parentMessageUserName,
    replyParentUserDisplayName: message.parentMessageUserDisplayName,
    threadMessageId: message.threadMessageId,
    threadMessageUserId: message.threadMessageUserId,
    threadMessageUserLogin: message.threadMessageUserName,
    threadMessageUserDisplayName: message.threadMessageUserDisplayName,
    isCheer: message.isCheer,
    bits: message.bits,
    isRedemption: message.isRedemption,
    rewardId: message.rewardId,
    sourceBroadcasterId: message.sourceBroadcasterId,
    sourceBroadcasterLogin: message.sourceBroadcasterName,
    sourceBroadcasterDisplayName: message.sourceBroadcasterDisplayName,
    sourceChatMessageId: message.sourceMessageId,
    isSourceOnly: message.isSourceOnly,
    parts: normalizeParts(message),
  };
}
