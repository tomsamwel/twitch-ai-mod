import { readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { loadEnvFile } from "./env.js";
import {
  appConfigSchema,
  controlPlaneSchema,
  cooldownsSchema,
  envSchema,
  moderationPolicySchema,
} from "./schema.js";
import type { ConfigSnapshot, PromptSnapshot } from "../types.js";

async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function readYamlFile<T>(filePath: string, schema: { parse: (value: unknown) => T }): Promise<T> {
  const raw = await readTextFile(filePath);
  const parsed = YAML.parse(raw) as unknown;
  return schema.parse(parsed);
}

async function readAppConfig(filePath: string): Promise<ReturnType<typeof appConfigSchema.parse>> {
  const raw = YAML.parse(await readTextFile(filePath)) as
    | {
        ai?: Record<string, unknown>;
      }
    | null;

  if (raw?.ai && "promptPack" in raw.ai) {
    throw new Error(
      "config/app.yaml no longer supports ai.promptPack. Use promptPacks.defaultPack for file defaults, or use CLI/runtime overrides to change the active pack.",
    );
  }

  return appConfigSchema.parse(raw);
}

export async function readPromptPack(promptsDir: string, packName: string): Promise<PromptSnapshot> {
  const packDir = path.resolve(promptsDir, "packs", packName);

  const prompts: PromptSnapshot = {
    packName,
    system: await readTextFile(path.resolve(packDir, "system.md")),
    socialPersona: await readTextFile(path.resolve(packDir, "social-persona.md")),
    moderation: await readTextFile(path.resolve(packDir, "moderation.md")),
    responseStyle: await readTextFile(path.resolve(packDir, "response-style.md")),
    safetyRules: await readTextFile(path.resolve(packDir, "safety-rules.md")),
  };

  return prompts;
}

export async function loadConfig(
  rootDir = process.cwd(),
  overrides: {
    promptPack?: string;
    applyLoginEnvOverrides?: boolean;
  } = {},
): Promise<ConfigSnapshot> {
  await loadEnvFile(rootDir);

  const env = envSchema.parse(process.env);
  const configDir = path.resolve(rootDir, "config");
  const promptsDir = path.resolve(rootDir, "prompts");
  const promptPacksDir = path.resolve(promptsDir, "packs");
  const appConfig = await readAppConfig(path.resolve(configDir, "app.yaml"));
  const controlPlane = await readYamlFile(path.resolve(configDir, "control-plane.yaml"), controlPlaneSchema);
  const cooldowns = await readYamlFile(path.resolve(configDir, "cooldowns.yaml"), cooldownsSchema);
  const moderationPolicy = await readYamlFile(
    path.resolve(configDir, "moderation-policy.yaml"),
    moderationPolicySchema,
  );
  const promptPack = overrides.promptPack ?? appConfig.promptPacks.defaultPack;
  const prompts = await readPromptPack(promptsDir, promptPack);

  if (appConfig.ai.enabled && appConfig.ai.provider === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when ai.provider is openai and ai.enabled is true.");
  }

  return {
    paths: {
      rootDir,
      configDir,
      promptsDir,
      promptPacksDir,
      dataDir: path.resolve(rootDir, "data"),
    },
    app: appConfig.app,
    runtime: {
      ...appConfig.runtime,
      logLevel: env.APP_LOG_LEVEL ?? appConfig.runtime.logLevel,
    },
    storage: {
      sqlitePath: path.resolve(rootDir, appConfig.storage.sqlitePath),
    },
    promptPacks: appConfig.promptPacks,
    controlPlane,
    secrets: {
      ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    },
    twitch: {
      ...appConfig.twitch,
      broadcasterLogin: overrides.applyLoginEnvOverrides
        ? (env.TWITCH_BROADCASTER_LOGIN ?? appConfig.twitch.broadcasterLogin)
        : appConfig.twitch.broadcasterLogin,
      botLogin: overrides.applyLoginEnvOverrides
        ? (env.TWITCH_BOT_LOGIN ?? appConfig.twitch.botLogin)
        : appConfig.twitch.botLogin,
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
      redirectUri: env.TWITCH_REDIRECT_URI,
      oauthHost: env.TWITCH_OAUTH_HOST,
      oauthPort: env.TWITCH_OAUTH_PORT,
    },
    ai: {
      ...appConfig.ai,
      promptPack,
    },
    actions: appConfig.actions,
    cooldowns,
    moderationPolicy,
    prompts,
  };
}
