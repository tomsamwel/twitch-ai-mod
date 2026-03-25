import { createFixedRuntimeSettings } from "../src/control/runtime-settings.js";
import type { AiContextSnapshot, ChatMessageEventLike, ConfigSnapshot } from "../src/types.js";

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
      trustedControllerLogins: ["testchannel"],
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
    },
    twitch: {
      broadcasterLogin: "testchannel",
      botLogin: "testbot",
      requiredScopes: ["user:read:chat", "user:write:chat", "moderator:manage:banned_users"],
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
        maxOutputTokens: 120,
        timeoutMs: 30000,
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
        model: "gpt-4.1-mini",
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
      },
      moderation: {
        minimumSecondsBetweenModerationActionsPerUser: 300,
        minimumSecondsBetweenEquivalentActions: 30,
      },
      ai: {
        minimumSecondsBetweenAiReviewsForSameUser: 10,
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
        escalationThresholds: {
          timeoutOnBlockedTerm: true,
          timeoutOnSpam: true,
        },
      },
      aiPolicy: {
        enabled: true,
        mode: "advisory",
        socialReplyStyle: "firm-but-friendly",
        moderationStyle: "moderation-first",
        abstainByDefault: true,
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
