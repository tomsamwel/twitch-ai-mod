import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

export const envSchema = z.object({
  TWITCH_CLIENT_ID: z.string().min(1, "TWITCH_CLIENT_ID is required"),
  TWITCH_CLIENT_SECRET: z.string().min(1, "TWITCH_CLIENT_SECRET is required"),
  TWITCH_REDIRECT_URI: z.string().url("TWITCH_REDIRECT_URI must be a valid URL"),
  TWITCH_OAUTH_HOST: z.string().min(1).default("localhost"),
  TWITCH_OAUTH_PORT: z.coerce.number().int().positive().default(3000),
  OPENAI_API_KEY: z.string().min(1).optional(),
  APP_LOG_LEVEL: logLevelSchema.optional(),
});

export const appConfigSchema = z.object({
  app: z.object({
    name: z.string().min(1),
    environment: z.string().min(1),
  }),
  runtime: z.object({
    dryRun: z.boolean(),
    logLevel: logLevelSchema,
    tokenValidationIntervalMinutes: z.number().int().positive(),
  }),
  storage: z.object({
    sqlitePath: z.string().min(1),
  }),
  promptPacks: z.object({
    defaultPack: z.string().min(1),
  }),
  twitch: z.object({
    broadcasterLogin: z.string().min(1),
    botLogin: z.string().min(1),
    requiredScopes: z.array(z.string().min(1)).min(1),
  }),
  ai: z.object({
    enabled: z.boolean(),
    provider: z.enum(["ollama", "openai"]),
    requestDefaults: z.object({
      temperature: z.number().min(0).max(2),
      maxOutputTokens: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    }),
    context: z.object({
      recentRoomMessages: z.number().int().nonnegative(),
      recentUserMessages: z.number().int().nonnegative(),
      recentBotInteractions: z.number().int().nonnegative(),
      maxPromptChars: z.number().int().positive(),
    }),
    ollama: z.object({
      baseUrl: z.url(),
      model: z.string().min(1),
    }),
    openai: z.object({
      baseUrl: z.url(),
      model: z.string().min(1),
    }),
  }),
  actions: z.object({
    allowLiveChatMessages: z.boolean(),
    allowLiveModeration: z.boolean(),
  }),
});

export const controlPlaneSchema = z.object({
  enabled: z.boolean(),
  commandPrefix: z.string().min(1),
  trustedControllerLogins: z.array(z.string().min(1)),
  broadcasterAlwaysAllowed: z.boolean(),
  allowedPromptPacks: z.array(z.string().min(1)).min(1),
  modelPresets: z.record(
    z.string().min(1),
    z.object({
      provider: z.enum(["ollama", "openai"]),
      baseUrl: z.url(),
      model: z.string().min(1),
    }),
  ),
});

export const cooldownsSchema = z.object({
  chat: z.object({
    minimumSecondsBetweenBotMessages: z.number().int().nonnegative(),
    minimumSecondsBetweenBotRepliesToSameUser: z.number().int().nonnegative(),
  }),
  moderation: z.object({
    minimumSecondsBetweenModerationActionsPerUser: z.number().int().nonnegative(),
    minimumSecondsBetweenEquivalentActions: z.number().int().nonnegative(),
  }),
  ai: z.object({
    minimumSecondsBetweenAiReviewsForSameUser: z.number().int().nonnegative(),
  }),
});

export const moderationPolicySchema = z.object({
  deterministicRules: z.object({
    blockedTerms: z.array(z.string().min(1)),
    timeoutSeconds: z.number().int().positive(),
    spam: z.object({
      maxRepeatedCharacters: z.number().int().positive(),
      maxEmotesPerMessage: z.number().int().positive(),
      maxMentionsPerMessage: z.number().int().positive(),
    }),
    escalationThresholds: z.object({
      timeoutOnBlockedTerm: z.boolean(),
      timeoutOnSpam: z.boolean(),
    }),
  }),
  aiPolicy: z.object({
    enabled: z.boolean(),
    mode: z.literal("advisory"),
    socialReplyStyle: z.string().min(1),
    moderationStyle: z.string().min(1),
    abstainByDefault: z.boolean(),
  }),
});

export type EnvConfig = z.infer<typeof envSchema>;
export type AppConfigFile = z.infer<typeof appConfigSchema>;
export type ControlPlaneFile = z.infer<typeof controlPlaneSchema>;
export type CooldownsFile = z.infer<typeof cooldownsSchema>;
export type ModerationPolicyFile = z.infer<typeof moderationPolicySchema>;
