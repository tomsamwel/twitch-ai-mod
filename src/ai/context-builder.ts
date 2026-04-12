import type { BotDatabase } from "../storage/database.js";
import type {
  AiContextInteraction,
  AiContextMessage,
  AiContextSnapshot,
  ConfigSnapshot,
  NormalizedChatMessage,
  PersistedActionRecord,
  PersistedMessageSnapshot,
  ProcessingMode,
  TwitchIdentity,
} from "../types.js";

/** Keep context text short to stay within the ~4096 token LLM window. */
const MAX_MESSAGE_TEXT_CHARS = 220;
const MAX_ACTION_TEXT_CHARS = 180;

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
    text: trimText(snapshot.message.text, MAX_MESSAGE_TEXT_CHARS),
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
    reason: trimText(action.reason, MAX_ACTION_TEXT_CHARS),
    targetUserId: action.targetUserId,
    targetUserName: action.targetUserName,
    ...(action.payload.message ? { message: trimText(action.payload.message, MAX_ACTION_TEXT_CHARS) } : {}),
    ...(action.payload.durationSeconds ? { durationSeconds: action.payload.durationSeconds } : {}),
    processingMode: action.processingMode,
  };
}

function estimateContextSize(snapshot: AiContextSnapshot): number {
  return JSON.stringify(snapshot).length;
}

// Iteratively removes the least-important context entries until the snapshot
// fits within the budget. JSON.stringify per iteration is acceptable here
// because context arrays are small (typically < 20 entries total).
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
    private readonly database: Pick<
      BotDatabase,
      "listRecentRoomMessageSnapshots" | "listRecentUserMessageSnapshots" | "listRecentBotInteractions"
    >,
  ) {}

  public build(
    message: NormalizedChatMessage,
    botIdentity: TwitchIdentity,
    processingMode: ProcessingMode = "live",
  ): AiContextSnapshot {
    const roomSnapshots = this.database.listRecentRoomMessageSnapshots(
      message.receivedAt,
      message.eventId,
      this.config.ai.context.recentRoomMessages,
      [processingMode],
    );
    const roomEventIds = new Set(roomSnapshots.map((snapshot) => snapshot.eventId));
    // Over-fetch user messages to account for overlap with room messages, then
    // deduplicate and trim to the configured limit.
    const userSnapshots = this.database
      .listRecentUserMessageSnapshots(
        message.chatterId,
        message.receivedAt,
        message.eventId,
        this.config.ai.context.recentUserMessages + this.config.ai.context.recentRoomMessages,
        [processingMode],
      )
      .filter((snapshot) => !roomEventIds.has(snapshot.eventId))
      .slice(-this.config.ai.context.recentUserMessages);
    const interactions = this.database
      .listRecentBotInteractions(
        message.chatterId,
        message.receivedAt,
        this.config.ai.context.recentBotInteractions,
        [processingMode],
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
