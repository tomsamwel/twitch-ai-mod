import { createFixedRuntimeSettings } from "../src/control/runtime-settings.js";
import type { AiContextSnapshot, ChatMessageEventLike, ConfigSnapshot, NormalizedChatMessage } from "../src/types.js";

export const DEFAULT_URL_RESULT: NormalizedChatMessage["urlResult"] = {
  detected: false,
  urls: [],
};

export function createTestConfig(): ConfigSnapshot {
  return {
    paths: {
      rootDir: "/tmp/twitch-ai-mod-test",
      configDir: "/tmp/twitch-ai-mod-test/config",
      promptsDir: "/tmp/twitch-ai-mod-test/prompts",
      promptPacksDir: "/tmp/twitch-ai-mod-test/prompts/packs",
      dataDir: "/tmp/twitch-ai-mod-test/data",
    },
    app: {
      name: "twitch-ai-mod-test",
      environment: "test",
    },
    runtime: {
      dryRun: true,
      logLevel: "info",
      tokenValidationIntervalMinutes: 60,
      eventSubDisconnectGraceSeconds: 600,
      exitOnEventSubStall: true,
    },
    storage: {
      sqlitePath: "/tmp/twitch-ai-mod-test/data/test.sqlite",
    },
    promptPacks: {
      defaultPack: "witty-mod",
    },
    controlPlane: {
      enabled: true,
      commandPrefix: "aimod",
      trustedControllers: [{ login: "testchannel", role: "admin" }],
      broadcasterAlwaysAllowed: true,
      allowedPromptPacks: ["witty-mod", "safer-control"],
      modelPresets: {
        "local-default": {
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen3:4b-instruct",
        },
        "local-fast": {
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5:1.5b",
        },
      },
    },
    secrets: {
      openaiApiKey: "openai-test-key",
      azureFoundryApiKey: "azure-foundry-test-key",
    },
    twitch: {
      broadcasterLogin: "testchannel",
      botLogin: "testbot",
      requiredScopes: ["user:read:chat", "user:write:chat", "moderator:manage:banned_users"],
      channelRules: [],
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3000/callback",
      oauthHost: "localhost",
      oauthPort: 3000,
    },
    ai: {
      enabled: true,
      provider: "ollama",
      promptPack: "witty-mod",
      requestDefaults: {
        temperature: 0,
        maxOutputTokens: 150,
        timeoutMs: 45000,
      },
      context: {
        recentRoomMessages: 5,
        recentUserMessages: 8,
        recentBotInteractions: 4,
        maxPromptChars: 4000,
      },
      ollama: {
        baseUrl: "http://localhost:11434",
        model: "qwen3:4b-instruct",
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      azureFoundry: {
        baseUrl: "https://example-resource.openai.azure.com/openai/v1/",
        deployment: "gpt-4.1-mini",
        apiStyle: "chat-completions",
      },
      queue: {
        capacity: 50,
        concurrency: 1,
        moderationStalenessMs: 0,
        socialStalenessMs: 30_000,
        pressureSignalCooldownMs: 60_000,
      },
    },
    actions: {
      allowLiveChatMessages: true,
      allowLiveModeration: false,
    },
    cooldowns: {
      chat: {
        minimumSecondsBetweenBotMessages: 45,
        minimumSecondsBetweenBotRepliesToSameUser: 120,
        minimumSecondsBetweenModerationNotices: 20,
        minimumSecondsBetweenModerationNoticesPerUser: 45,
      },
      moderation: {
        minimumSecondsBetweenModerationActionsPerUser: 300,
        minimumSecondsBetweenEquivalentActions: 30,
      },
      ai: {
        minimumSecondsBetweenAiModerationReviewsForSameUser: 10,
        minimumSecondsBetweenAiSocialReviewsForSameUser: 5,
      },
    },
    moderationPolicy: {
      deterministicRules: {
        blockedTerms: ["buy followers", "buy viewers", "cheap viewers", "viewer bot", "follow for follow"],
        timeoutSeconds: 300,
        spam: {
          maxRepeatedCharacters: 10,
          maxEmotesPerMessage: 8,
          maxMentionsPerMessage: 4,
        },
        visualSpam: {
          enabled: true,
          minimumHighConfidenceScore: 8,
          minimumBorderlineScore: 5,
          minimumVisibleCharacters: 24,
          minimumLineCount: 2,
          minimumLongestLineLength: 18,
          minimumDenseSymbolRunLength: 8,
          minimumRepeatedVisualLines: 2,
          minimumSymbolDensity: 0.45,
          maximumNaturalWordRatio: 0.35,
        },
        escalationThresholds: {
          timeoutOnBlockedTerm: true,
          timeoutOnSpam: true,
        },
      },
      publicNotices: {
        blockedTerm: "Scam pitches get timed out. Try a better hobby.",
        spamHeuristic: "Cut the spam. Chat is not your drywall.",
        visualSpamAsciiArt: "Keep giant ASCII art out of chat. This is not cave painting hour.",
        generic: "That crossed the line. Dial it back.",
      },
      aiPolicy: {
        enabled: true,
        mode: "advisory",
        socialReplyStyle: "firm-but-friendly",
        moderationStyle: "moderation-first",
        abstainByDefault: true,
        liveTimeouts: {
          mode: "hard-gated",
          minimumConfidence: 0.9,
          allowedCategories: [
            "scam",
            "targeted-harassment",
            "sexual-harassment",
            "spam-escalation",
            "irl-safety",
          ],
        },
      },
    },
    prompts: {
      packName: "witty-mod",
      system: "system prompt",
      socialPersona: "social persona prompt",
      moderation: "moderation prompt",
      responseStyle: "response style prompt",
      safetyRules: "safety prompt",
    },
  };
}

export async function withMockFetch<T>(
  implementation: typeof fetch,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function createEmptyContext(): AiContextSnapshot {
  return {
    recentRoomMessages: [],
    recentUserMessages: [],
    recentBotInteractions: [],
  };
}

export function createTestRuntimeSettings(
  config: ConfigSnapshot,
  overrides: Parameters<typeof createFixedRuntimeSettings>[1] = {},
) {
  return createFixedRuntimeSettings(config, overrides);
}

export function createChatEvent(overrides: Partial<ChatMessageEventLike> = {}): ChatMessageEventLike {
  return {
    messageId: "msg-1",
    messageText: "hello world",
    messageType: "text",
    broadcasterId: "broadcaster-1",
    broadcasterName: "testchannel",
    broadcasterDisplayName: "TestChannel",
    chatterId: "user-1",
    chatterName: "viewerone",
    chatterDisplayName: "ViewerOne",
    color: "#00FF00",
    badges: {},
    parentMessageId: null,
    parentMessageUserId: null,
    parentMessageUserName: null,
    parentMessageUserDisplayName: null,
    threadMessageId: null,
    threadMessageUserId: null,
    threadMessageUserName: null,
    threadMessageUserDisplayName: null,
    isCheer: false,
    bits: 0,
    isRedemption: false,
    rewardId: null,
    sourceBroadcasterId: null,
    sourceBroadcasterName: null,
    sourceBroadcasterDisplayName: null,
    sourceMessageId: null,
    isSourceOnly: null,
    messageParts: [
      {
        type: "text",
        text: "hello world",
      },
    ],
    ...overrides,
  };
}
