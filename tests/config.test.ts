import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config/load-config.js";

const ENV_KEYS = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_REDIRECT_URI",
  "TWITCH_OAUTH_HOST",
  "TWITCH_OAUTH_PORT",
  "OPENAI_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
  "APP_LOG_LEVEL",
] as const;

async function createFixtureProject(rootDir: string, appYaml: string): Promise<void> {
  await mkdir(path.join(rootDir, "config"), { recursive: true });
  await mkdir(path.join(rootDir, "prompts", "packs", "witty-mod"), { recursive: true });
  await mkdir(path.join(rootDir, "prompts", "packs", "safer-control"), { recursive: true });

  await writeFile(path.join(rootDir, "config", "app.yaml"), appYaml);
  await writeFile(
    path.join(rootDir, "config", "control-plane.yaml"),
    `
enabled: true
commandPrefix: aimod
trustedControllers:
  - login: testchannel
    role: admin
broadcasterAlwaysAllowed: true
allowedPromptPacks:
  - witty-mod
  - safer-control
modelPresets:
  local-default:
    provider: ollama
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  local-fast:
    provider: ollama
    baseUrl: http://localhost:11434
    model: qwen2.5:1.5b
`,
  );
  await writeFile(
    path.join(rootDir, "config", "cooldowns.yaml"),
    `
chat:
  minimumSecondsBetweenBotMessages: 45
  minimumSecondsBetweenBotRepliesToSameUser: 120
  minimumSecondsBetweenModerationNotices: 20
  minimumSecondsBetweenModerationNoticesPerUser: 45
moderation:
  minimumSecondsBetweenModerationActionsPerUser: 300
  minimumSecondsBetweenEquivalentActions: 30
ai:
  minimumSecondsBetweenAiModerationReviewsForSameUser: 10
  minimumSecondsBetweenAiSocialReviewsForSameUser: 5
`,
  );
  await writeFile(
    path.join(rootDir, "config", "moderation-policy.yaml"),
    `
deterministicRules:
  blockedTerms:
    - buy followers
  timeoutSeconds: 300
  spam:
    maxRepeatedCharacters: 10
    maxEmotesPerMessage: 8
    maxMentionsPerMessage: 4
  visualSpam:
    enabled: true
    minimumHighConfidenceScore: 8
    minimumBorderlineScore: 5
    minimumVisibleCharacters: 24
    minimumLineCount: 2
    minimumLongestLineLength: 18
    minimumDenseSymbolRunLength: 8
    minimumRepeatedVisualLines: 2
    minimumSymbolDensity: 0.45
    maximumNaturalWordRatio: 0.35
  escalationThresholds:
    timeoutOnBlockedTerm: true
    timeoutOnSpam: true
publicNotices:
  blockedTerm: Scam pitches get timed out. Try a better hobby.
  spamHeuristic: Cut the spam. Chat is not your drywall.
  visualSpamAsciiArt: Keep giant ASCII art out of chat. This is not cave painting hour.
  generic: That crossed the line. Dial it back.
aiPolicy:
  enabled: true
  mode: advisory
  socialReplyStyle: firm-but-friendly
  moderationStyle: moderation-first
  abstainByDefault: true
  liveTimeouts:
    mode: hard-gated
    minimumConfidence: 0.9
    allowedCategories:
      - scam
      - targeted-harassment
      - sexual-harassment
      - spam-escalation
`,
  );

  await Promise.all(
    [
      "system.md",
      "social-persona.md",
      "moderation.md",
      "response-style.md",
      "safety-rules.md",
    ].flatMap((fileName) => [
      writeFile(path.join(rootDir, "prompts", "packs", "witty-mod", fileName), `witty ${fileName} content`),
      writeFile(path.join(rootDir, "prompts", "packs", "safer-control", fileName), `control ${fileName} content`),
    ]),
  );
}

function setTestEnv(): Record<string, string | undefined> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.TWITCH_CLIENT_ID = "client-id";
  process.env.TWITCH_CLIENT_SECRET = "client-secret";
  process.env.TWITCH_REDIRECT_URI = "http://localhost:3000/callback";
  process.env.TWITCH_OAUTH_HOST = "localhost";
  process.env.TWITCH_OAUTH_PORT = "3000";
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.AZURE_FOUNDRY_API_KEY = "azure-foundry-test-key";
  process.env.APP_LOG_LEVEL = "debug";
  return previous;
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous[key];

    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

test("loadConfig assembles config, prompts, and env overrides", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-"));
  const previousEnv = setTestEnv();

  try {
    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: ollama
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    const config = await loadConfig(rootDir);

    assert.equal(config.runtime.logLevel, "debug");
    assert.equal(config.twitch.clientId, "client-id");
    assert.equal(config.twitch.broadcasterLogin, "testchannel");
    assert.equal(config.prompts.packName, "witty-mod");
    assert.equal(config.prompts.system, "witty system.md content");
    assert.equal(config.storage.sqlitePath, path.join(rootDir, "data", "test.sqlite"));
    assert.equal(config.controlPlane.commandPrefix, "aimod");
    assert.equal(config.controlPlane.modelPresets["local-default"]?.model, "qwen3:4b-instruct");
    assert.equal(config.runtime.eventSubDisconnectGraceSeconds, 600);
    assert.equal(config.runtime.exitOnEventSubStall, true);
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig fails clearly on invalid app config", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-invalid-"));
  const previousEnv = setTestEnv();

  try {
    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: ""
  requiredScopes:
    - user:read:chat
ai:
  enabled: true
  provider: ollama
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    await assert.rejects(() => loadConfig(rootDir));
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig requires OPENAI_API_KEY only when OpenAI is selected and enabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-openai-"));
  const previousEnv = setTestEnv();

  try {
    delete process.env.OPENAI_API_KEY;

    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: openai
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    await assert.rejects(
      () => loadConfig(rootDir),
      /OPENAI_API_KEY is required when ai.provider is openai and ai.enabled is true/u,
    );
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig requires AZURE_FOUNDRY_API_KEY only when Azure AI Foundry is selected and enabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-azure-foundry-"));
  const previousEnv = setTestEnv();

  try {
    delete process.env.AZURE_FOUNDRY_API_KEY;

    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: azure-foundry
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
  azureFoundry:
    baseUrl: https://example-resource.openai.azure.com/openai/v1/
    deployment: gpt-4.1-mini
    apiStyle: chat-completions
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    await assert.rejects(
      () => loadConfig(rootDir),
      /AZURE_FOUNDRY_API_KEY is required when ai.provider is azure-foundry and ai.enabled is true/u,
    );
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig can override the prompt pack at load time", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-pack-"));
  const previousEnv = setTestEnv();

  try {
    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: ollama
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    const config = await loadConfig(rootDir, { promptPack: "safer-control" });

    assert.equal(config.prompts.packName, "safer-control");
    assert.equal(config.ai.promptPack, "safer-control");
    assert.equal(config.prompts.system, "control system.md content");
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects deprecated file-level ai.promptPack configuration", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-deprecated-pack-"));
  const previousEnv = setTestEnv();

  try {
    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: ollama
  promptPack: safer-control
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    await assert.rejects(
      () => loadConfig(rootDir),
      /no longer supports ai\.promptPack/u,
    );
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("loadConfig fails clearly when the requested prompt pack does not exist", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "twitch-ai-mod-config-missing-pack-"));
  const previousEnv = setTestEnv();

  try {
    await createFixtureProject(
      rootDir,
      `
app:
  name: twitch-ai-mod
  environment: test
runtime:
  dryRun: true
  logLevel: info
  tokenValidationIntervalMinutes: 60
storage:
  sqlitePath: ./data/test.sqlite
promptPacks:
  defaultPack: witty-mod
twitch:
  broadcasterLogin: testchannel
  botLogin: testbot
  requiredScopes:
    - user:read:chat
    - user:write:chat
    - moderator:manage:banned_users
ai:
  enabled: true
  provider: ollama
  requestDefaults:
    temperature: 0
    maxOutputTokens: 200
    timeoutMs: 45000
  context:
    recentRoomMessages: 5
    recentUserMessages: 8
    recentBotInteractions: 4
    maxPromptChars: 4000
  ollama:
    baseUrl: http://localhost:11434
    model: qwen3:4b-instruct
  openai:
    baseUrl: https://api.openai.com/v1
    model: gpt-4o-mini
actions:
  allowLiveChatMessages: true
  allowLiveModeration: false
`,
    );

    await assert.rejects(
      () => loadConfig(rootDir, { promptPack: "missing-pack" }),
      /missing-pack/u,
    );
  } finally {
    restoreEnv(previousEnv);
    await rm(rootDir, { recursive: true, force: true });
  }
});
