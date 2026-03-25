import type {
  AiContextInteraction,
  AiContextMessage,
  AiContextSnapshot,
  ConfigSnapshot,
  NormalizedChatMessage,
  PersistedActionRecord,
  PersistedMessageSnapshot,
  TwitchIdentity,
} from "../types.js";

interface ContextStore {
  listRecentRoomMessageSnapshots(
    beforeReceivedAt: string,
    excludeEventId: string,
    limit: number,
  ): PersistedMessageSnapshot[];
  listRecentUserMessageSnapshots(
    chatterId: string,
    beforeReceivedAt: string,
    excludeEventId: string,
    limit: number,
  ): PersistedMessageSnapshot[];
  listRecentBotInteractions(targetUserId: string, beforeCreatedAt: string, limit: number): PersistedActionRecord[];
}

function trimText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function summarizeMessage(snapshot: PersistedMessageSnapshot, botIdentity: TwitchIdentity): AiContextMessage {
  return {
    eventId: snapshot.eventId,
    receivedAt: snapshot.receivedAt,
    chatterId: snapshot.message.chatterId,
    chatterLogin: snapshot.message.chatterLogin,
    chatterDisplayName: snapshot.message.chatterDisplayName,
    text: trimText(snapshot.message.text, 220),
    roles: snapshot.message.roles,
    isPrivileged: snapshot.message.isPrivileged,
    isBotMessage:
      snapshot.message.chatterId === botIdentity.id ||
      snapshot.message.chatterLogin.toLowerCase() === botIdentity.login.toLowerCase(),
  };
}

function summarizeInteraction(action: PersistedActionRecord): AiContextInteraction {
  return {
    id: action.id,
    createdAt: action.createdAt,
    kind: action.kind,
    source: action.source,
    status: action.status,
    dryRun: action.dryRun,
    reason: trimText(action.reason, 180),
    targetUserId: action.targetUserId,
    targetUserName: action.targetUserName,
    ...(action.payload.message ? { message: trimText(action.payload.message, 180) } : {}),
    ...(action.payload.durationSeconds ? { durationSeconds: action.payload.durationSeconds } : {}),
    processingMode: action.processingMode,
  };
}

function estimateContextSize(snapshot: AiContextSnapshot): number {
  return JSON.stringify(snapshot).length;
}

function pruneContextToBudget(snapshot: AiContextSnapshot, maxPromptChars: number): AiContextSnapshot {
  const nextSnapshot: AiContextSnapshot = {
    recentRoomMessages: [...snapshot.recentRoomMessages],
    recentUserMessages: [...snapshot.recentUserMessages],
    recentBotInteractions: [...snapshot.recentBotInteractions],
  };

  while (estimateContextSize(nextSnapshot) > maxPromptChars) {
    if (nextSnapshot.recentRoomMessages.length > 0) {
      nextSnapshot.recentRoomMessages.shift();
      continue;
    }

    if (nextSnapshot.recentUserMessages.length > 0) {
      nextSnapshot.recentUserMessages.shift();
      continue;
    }

    if (nextSnapshot.recentBotInteractions.length > 0) {
      nextSnapshot.recentBotInteractions.shift();
      continue;
    }

    break;
  }

  return nextSnapshot;
}

export class AiContextBuilder {
  public constructor(
    private readonly config: Pick<ConfigSnapshot, "ai">,
    private readonly database: ContextStore,
  ) {}

  public build(message: NormalizedChatMessage, botIdentity: TwitchIdentity): AiContextSnapshot {
    const roomSnapshots = this.database.listRecentRoomMessageSnapshots(
      message.receivedAt,
      message.eventId,
      this.config.ai.context.recentRoomMessages,
    );
    const roomEventIds = new Set(roomSnapshots.map((snapshot) => snapshot.eventId));
    const userSnapshots = this.database
      .listRecentUserMessageSnapshots(
        message.chatterId,
        message.receivedAt,
        message.eventId,
        this.config.ai.context.recentUserMessages + this.config.ai.context.recentRoomMessages,
      )
      .filter((snapshot) => !roomEventIds.has(snapshot.eventId))
      .slice(-this.config.ai.context.recentUserMessages);
    const interactions = this.database
      .listRecentBotInteractions(
        message.chatterId,
        message.receivedAt,
        this.config.ai.context.recentBotInteractions,
      )
      .map(summarizeInteraction);

    return pruneContextToBudget(
      {
        recentRoomMessages: roomSnapshots.map((snapshot) => summarizeMessage(snapshot, botIdentity)),
        recentUserMessages: userSnapshots.map((snapshot) => summarizeMessage(snapshot, botIdentity)),
        recentBotInteractions: interactions,
      },
      this.config.ai.context.maxPromptChars,
    );
  }
}
