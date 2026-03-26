import { z } from "zod";

export const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export type AiProviderKind = "ollama" | "openai" | "llama-cpp";
export type AiMode = "social" | "moderation";
export const moderationCategorySchema = z.enum([
  "none",
  "scam",
  "targeted-harassment",
  "sexual-harassment",
  "spam-escalation",
  "soft-promo",
  "rude-disruption",
  "other",
]);
export type ModerationCategory = z.infer<typeof moderationCategorySchema>;
export type ProcessingMode = "live" | "replay" | "scenario";
export type RuntimeOverrideKey =
  | "aiEnabled"
  | "aiModerationEnabled"
  | "socialRepliesEnabled"
  | "dryRun"
  | "liveModerationEnabled"
  | "promptPack"
  | "modelPreset";

export type ActionKind = "say" | "warn" | "timeout";
export type ReviewVerdict =
  | "ignore"
  | "keep-for-monitoring"
  | "promote-to-scenario"
  | "prompt-fix"
  | "policy-fix";

export interface NormalizedMessagePart {
  type: "text" | "mention" | "emote" | "cheermote";
  text: string;
  mentionUserId?: string;
  mentionUserLogin?: string;
  mentionUserName?: string;
  bits?: number;
  emoteId?: string;
}

export interface NormalizedChatMessage {
  eventId: string;
  sourceMessageId: string;
  receivedAt: string;
  broadcasterId: string;
  broadcasterLogin: string;
  broadcasterDisplayName: string;
  chatterId: string;
  chatterLogin: string;
  chatterDisplayName: string;
  text: string;
  color: string | null;
  messageType: string;
  badges: Record<string, string>;
  roles: string[];
  isPrivileged: boolean;
  isReply: boolean;
  replyParentMessageId: string | null;
  replyParentUserId: string | null;
  replyParentUserLogin: string | null;
  replyParentUserDisplayName: string | null;
  threadMessageId: string | null;
  threadMessageUserId: string | null;
  threadMessageUserLogin: string | null;
  threadMessageUserDisplayName: string | null;
  isCheer: boolean;
  bits: number;
  isRedemption: boolean;
  rewardId: string | null;
  sourceBroadcasterId: string | null;
  sourceBroadcasterLogin: string | null;
  sourceBroadcasterDisplayName: string | null;
  sourceChatMessageId: string | null;
  isSourceOnly: boolean | null;
  parts: NormalizedMessagePart[];
}

export interface RuleDecision {
  source: "rules";
  outcome: "no_action" | "action" | "suppressed";
  reason: string;
  matchedRule?: string;
  actions: ProposedAction[];
  metadata?: Record<string, unknown>;
}

export interface AiDecision {
  source: AiProviderKind;
  outcome: "abstain" | "action";
  reason: string;
  confidence: number;
  mode: AiMode;
  moderationCategory: ModerationCategory;
  actions: ProposedAction[];
  metadata?: Record<string, unknown>;
}

export interface ProposedAction {
  kind: ActionKind;
  reason: string;
  message?: string;
  targetUserId?: string;
  targetUserName?: string;
  durationSeconds?: number;
  replyParentMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface ActionRequest extends ProposedAction {
  id: string;
  source: "rules" | "ai";
  sourceEventId: string;
  sourceMessageId: string;
  processingMode: ProcessingMode;
  runId?: string;
  dryRun: boolean;
  initiatedAt: string;
}

export interface ActionResult {
  id: string;
  kind: ActionKind;
  status: "executed" | "dry-run" | "skipped" | "failed";
  dryRun: boolean;
  reason: string;
  externalMessageId?: string;
  error?: string;
}

export interface OAuthTokenRecord {
  provider: "twitch";
  userId: string;
  login: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  expiresIn: number | null;
  obtainmentTimestamp: number;
}

export interface PromptSnapshot {
  packName: string;
  system: string;
  socialPersona: string;
  moderation: string;
  responseStyle: string;
  safetyRules: string;
}

export interface AiContextMessage {
  eventId: string;
  receivedAt: string;
  chatterId: string;
  chatterLogin: string;
  chatterDisplayName: string;
  text: string;
  roles: string[];
  isPrivileged: boolean;
  isBotMessage: boolean;
}

export interface AiContextInteraction {
  id: string;
  createdAt: string;
  kind: ActionKind;
  source: "rules" | "ai";
  status: ActionResult["status"];
  dryRun: boolean;
  reason: string;
  targetUserId: string | null;
  targetUserName: string | null;
  message?: string;
  durationSeconds?: number;
  processingMode: ProcessingMode;
}

export interface AiContextSnapshot {
  recentRoomMessages: AiContextMessage[];
  recentUserMessages: AiContextMessage[];
  recentBotInteractions: AiContextInteraction[];
}

export interface ConfigSnapshot {
  paths: {
    rootDir: string;
    configDir: string;
    promptsDir: string;
    promptPacksDir: string;
    dataDir: string;
  };
  app: {
    name: string;
    environment: string;
  };
  runtime: {
    dryRun: boolean;
    logLevel: LogLevel;
    tokenValidationIntervalMinutes: number;
  };
  storage: {
    sqlitePath: string;
  };
  secrets: {
    openaiApiKey?: string;
  };
  twitch: {
    broadcasterLogin: string;
    botLogin: string;
    requiredScopes: string[];
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    oauthHost: string;
    oauthPort: number;
  };
  promptPacks: {
    defaultPack: string;
  };
  controlPlane: {
    enabled: boolean;
    commandPrefix: string;
    trustedControllerLogins: string[];
    broadcasterAlwaysAllowed: boolean;
    allowedPromptPacks: string[];
    modelPresets: Record<
      string,
      {
        provider: AiProviderKind;
        baseUrl: string;
        model: string;
      }
    >;
  };
  ai: {
    enabled: boolean;
    provider: AiProviderKind;
    promptPack: string;
    requestDefaults: {
      temperature: number;
      maxOutputTokens: number;
      timeoutMs: number;
    };
    context: {
      recentRoomMessages: number;
      recentUserMessages: number;
      recentBotInteractions: number;
      maxPromptChars: number;
    };
    ollama: {
      baseUrl: string;
      model: string;
      numCtx?: number | undefined;
      keepAlive?: number | undefined;
    };
    openai: {
      baseUrl: string;
      model: string;
    };
    llamaCpp?: {
      baseUrl: string;
      model: string;
    } | undefined;
  };
  actions: {
    allowLiveChatMessages: boolean;
    allowLiveModeration: boolean;
  };
  cooldowns: {
    chat: {
      minimumSecondsBetweenBotMessages: number;
      minimumSecondsBetweenBotRepliesToSameUser: number;
      minimumSecondsBetweenModerationNotices: number;
      minimumSecondsBetweenModerationNoticesPerUser: number;
    };
    moderation: {
      minimumSecondsBetweenModerationActionsPerUser: number;
      minimumSecondsBetweenEquivalentActions: number;
    };
    ai: {
      minimumSecondsBetweenAiModerationReviewsForSameUser: number;
      minimumSecondsBetweenAiSocialReviewsForSameUser: number;
    };
  };
  moderationPolicy: {
    deterministicRules: {
      blockedTerms: string[];
      timeoutSeconds: number;
      spam: {
        maxRepeatedCharacters: number;
        maxEmotesPerMessage: number;
        maxMentionsPerMessage: number;
      };
      visualSpam: {
        enabled: boolean;
        minimumHighConfidenceScore: number;
        minimumBorderlineScore: number;
        minimumVisibleCharacters: number;
        minimumLineCount: number;
        minimumLongestLineLength: number;
        minimumDenseSymbolRunLength: number;
        minimumRepeatedVisualLines: number;
        minimumSymbolDensity: number;
        maximumNaturalWordRatio: number;
      };
      escalationThresholds: {
        timeoutOnBlockedTerm: boolean;
        timeoutOnSpam: boolean;
      };
    };
    publicNotices: {
      blockedTerm: string;
      spamHeuristic: string;
      visualSpamAsciiArt: string;
      generic: string;
    };
    aiPolicy: {
      enabled: boolean;
      mode: "advisory";
      socialReplyStyle: string;
      moderationStyle: string;
      abstainByDefault: boolean;
      liveTimeouts: {
        mode: "hard-gated";
        minimumConfidence: number;
        allowedCategories: ModerationCategory[];
      };
    };
  };
  prompts: PromptSnapshot;
}

export interface AiPromptPayload {
  system: string;
  user: string;
}

export interface AiDecisionInput {
  mode: AiMode;
  message: NormalizedChatMessage;
  context: AiContextSnapshot;
  config: ConfigSnapshot;
  prompt: AiPromptPayload;
}

export interface TwitchIdentity {
  id: string;
  login: string;
  displayName: string;
}

export interface TwitchGatewayContext {
  broadcaster: TwitchIdentity;
  bot: TwitchIdentity;
}

export interface WhisperMessage {
  id: string;
  receivedAt: string;
  recipientUserId: string;
  recipientUserLogin: string;
  recipientUserDisplayName: string;
  senderUserId: string;
  senderUserLogin: string;
  senderUserDisplayName: string;
  text: string;
}

export interface PersistedMessageSnapshot {
  eventId: string;
  sourceMessageId: string;
  chatterId: string;
  chatterLogin: string;
  receivedAt: string;
  botIdentity: TwitchIdentity;
  message: NormalizedChatMessage;
  createdAt: string;
}

export interface PersistedActionRecord {
  id: string;
  kind: ActionKind;
  status: ActionResult["status"];
  source: "rules" | "ai";
  targetUserId: string | null;
  targetUserName: string | null;
  reason: string;
  dryRun: boolean;
  processingMode: ProcessingMode;
  payload: ActionRequest;
  result: ActionResult;
  createdAt: string;
}

export interface PersistedDecisionRecord {
  id: string;
  stage: "rules" | "ai";
  eventId: string;
  sourceMessageId: string;
  chatterId: string;
  chatterLogin: string;
  outcome: string;
  reason: string;
  matchedRule?: string;
  processingMode: ProcessingMode;
  runId?: string;
  payload: RuleDecision | AiDecision;
  createdAt: string;
}

export interface ReviewDecisionRecord {
  eventId: string;
  verdict: ReviewVerdict;
  notes: string | null;
  updatedAt: string;
}

export interface ChatMessageEventLike {
  messageId: string;
  messageText: string;
  messageType: string;
  broadcasterId: string;
  broadcasterName: string;
  broadcasterDisplayName: string;
  chatterId: string;
  chatterName: string;
  chatterDisplayName: string;
  color: string | null;
  badges: Record<string, string>;
  parentMessageId: string | null;
  parentMessageUserId: string | null;
  parentMessageUserName: string | null;
  parentMessageUserDisplayName: string | null;
  threadMessageId: string | null;
  threadMessageUserId: string | null;
  threadMessageUserName: string | null;
  threadMessageUserDisplayName: string | null;
  isCheer: boolean;
  bits: number;
  isRedemption: boolean;
  rewardId: string | null;
  sourceBroadcasterId: string | null;
  sourceBroadcasterName: string | null;
  sourceBroadcasterDisplayName: string | null;
  sourceMessageId: string | null;
  isSourceOnly: boolean | null;
  messageParts: Array<
    | {
        type: "text";
        text: string;
      }
    | {
        type: "mention";
        text: string;
        mention: {
          user_id: string;
          user_login: string;
          user_name: string;
        };
      }
    | {
        type: "cheermote";
        text: string;
        cheermote: {
          bits: number;
        };
      }
    | {
        type: "emote";
        text: string;
        emote: {
          id: string;
        };
      }
  >;
}

export interface TrustedController {
  userId: string;
  login: string;
  displayName: string;
  source: "config" | "broadcaster";
}

export type ControlCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "set-ai"; enabled: boolean }
  | { kind: "set-ai-moderation"; enabled: boolean }
  | { kind: "set-social"; enabled: boolean }
  | { kind: "set-dry-run"; enabled: boolean }
  | { kind: "set-live-moderation"; enabled: boolean }
  | { kind: "set-pack"; packName: string }
  | { kind: "set-model"; presetName: string }
  | { kind: "reset" };

export interface ControlCommandResult {
  accepted: boolean;
  success: boolean;
  replyMessage: string;
  commandSummary: string;
  highRisk: boolean;
  changes: Array<{
    key: RuntimeOverrideKey;
    previousValue: unknown;
    nextValue: unknown;
  }>;
}

export interface RuntimeOverrideSnapshot {
  aiEnabled?: boolean;
  aiModerationEnabled?: boolean;
  socialRepliesEnabled?: boolean;
  dryRun?: boolean;
  liveModerationEnabled?: boolean;
  promptPack?: string;
  modelPreset?: string;
  updatedAt: string | null;
  updatedByUserId: string | null;
  updatedByLogin: string | null;
}

export interface EffectiveRuntimeSettings {
  aiEnabled: boolean;
  aiModerationEnabled: boolean;
  socialRepliesEnabled: boolean;
  dryRun: boolean;
  liveModerationEnabled: boolean;
  promptPack: string;
  prompts: PromptSnapshot;
  modelPreset: string | null;
  provider: AiProviderKind;
  providerBaseUrl: string;
  model: string;
  lastOverrideAt: string | null;
  lastOverrideByLogin: string | null;
}

export interface RuntimeOverrideRecord {
  key: RuntimeOverrideKey;
  value: unknown;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByLogin: string | null;
}

export interface ControlAuditRecord {
  id: string;
  actorUserId: string;
  actorLogin: string;
  actorDisplayName: string;
  rawCommandText: string;
  parsedCommandJson: string | null;
  accepted: boolean;
  success: boolean;
  commandSummary: string;
  highRisk: boolean;
  replyMessage: string;
  changesJson: string;
  createdAt: string;
}
