import type { Logger } from "pino";

import { ActionExecutor } from "./actions/action-executor.js";
import { AdminServer } from "./admin/admin-server.js";
import { AiContextBuilder } from "./ai/context-builder.js";
import { AiProviderRegistry } from "./ai/provider-registry.js";
import { loadConfig, readPromptPack } from "./config/load-config.js";
import { WhisperControlPlane } from "./control/control-plane.js";
import { RuntimeSettingsStore } from "./control/runtime-settings.js";
import { CooldownManager } from "./moderation/cooldown-manager.js";
import { RuleEngine } from "./moderation/rule-engine.js";
import { AiReviewQueue, type PressureState } from "./runtime/ai-review-queue.js";
import { MessageProcessor, type AiReviewWorkItem } from "./runtime/message-processor.js";
import { createPriorityClassifier } from "./runtime/priority-classifier.js";
import { OutboundMessageTracker } from "./runtime/outbound-message-tracker.js";
import { BotDatabase } from "./storage/database.js";
import { createLogger } from "./storage/logger.js";
import { ensureLlamaServer } from "./scripts/script-support.js";
import type { LlamaServerManager } from "./admin/llama-server-manager.js";
import type { ConfigSnapshot, PromptSnapshot, TrustedController } from "./types.js";
import { createTwitchAuthContext } from "./twitch/auth.js";
import { TwurpleTwitchGateway } from "./twitch/twitch-gateway.js";

export interface AppServices {
  config: ConfigSnapshot;
  logger: Logger;
  database: BotDatabase;
  cooldowns: CooldownManager;
  ruleEngine: RuleEngine;
  runtimeSettings: RuntimeSettingsStore;
  twitchGateway: TwurpleTwitchGateway;
  actionExecutor: ActionExecutor;
  messageProcessor: MessageProcessor;
  aiReviewQueue: AiReviewQueue<AiReviewWorkItem>;
  controlPlane: WhisperControlPlane | null;
  adminServer: AdminServer | null;
  llamaServerManager: LlamaServerManager | null;
  close(): Promise<void>;
}

export async function createAppServices(): Promise<AppServices> {
  const config = await loadConfig(process.cwd(), { applyLoginEnvOverrides: true });
  const logger = createLogger(config.runtime.logLevel, config.app.name);
  const database = new BotDatabase(config.storage.sqlitePath);
  const authContext = await createTwitchAuthContext(config, database, logger);
  const promptPacks = await loadPromptPacks(config);
  const llamaServerManager = await ensureLlamaServer(config, logger);

  const runtimeSettings = new RuntimeSettingsStore(config, logger, database, promptPacks);
  const aiProviders = new AiProviderRegistry(config, logger);
  await aiProviders.getProvider(aiProviders.createEffectiveConfig(runtimeSettings.getEffectiveSettings()));
  const cooldowns = new CooldownManager(config.cooldowns);
  const isUserExempt = (login: string) => database.isUserExempt(login);
  const getRuntimeBlockedTerms = () => database.listRuntimeBlockedTerms();
  const ruleEngine = new RuleEngine(config, cooldowns, isUserExempt, getRuntimeBlockedTerms);
  const contextBuilder = new AiContextBuilder(config, database);
  const outboundMessageTracker = new OutboundMessageTracker();
  const twitchGateway = new TwurpleTwitchGateway(
    config,
    logger,
    authContext.apiClient,
    authContext.authProvider,
    {
      broadcaster: authContext.broadcaster,
      bot: authContext.bot,
    },
  );
  const classifyPriority = createPriorityClassifier(database);
  let lastPressureSignalAt = 0;
  const onPressure = (state: PressureState) => {
    if (!state.underPressure) return;
    const now = Date.now();
    if (now - lastPressureSignalAt < config.ai.queue.pressureSignalCooldownMs) return;
    lastPressureSignalAt = now;
    logger.warn({ ...state }, "AI queue under pressure — notifying broadcaster");
    twitchGateway.sendWhisper(
      authContext.broadcaster.id,
      `AI queue under pressure: ${state.highDepth} moderation + ${state.normalDepth} social queued, ${state.recentDrops} social replies dropped`,
    ).catch((err) => logger.debug({ err }, "failed to send pressure whisper"));
  };
  const aiReviewQueue = new AiReviewQueue<AiReviewWorkItem>(
    config.ai.queue, logger, classifyPriority, onPressure,
  );
  const actionExecutor = new ActionExecutor(
    config,
    logger,
    database,
    cooldowns,
    twitchGateway,
    runtimeSettings,
    outboundMessageTracker,
    isUserExempt,
  );
  const messageProcessor = new MessageProcessor(
    config,
    logger,
    database,
    cooldowns,
    ruleEngine,
    contextBuilder,
    runtimeSettings,
    aiProviders,
    actionExecutor,
    outboundMessageTracker,
    aiReviewQueue,
  );
  aiReviewQueue.start(async (work) => {
    await messageProcessor.processAiReview(work);
  });
  const controlPlane =
    config.controlPlane.enabled
      ? new WhisperControlPlane(
          config.controlPlane.commandPrefix,
          await resolveTrustedControllers(config, authContext),
          logger,
          runtimeSettings,
          database,
          twitchGateway,
          aiReviewQueue,
        )
      : null;

  const configControllers = (config.controlPlane.trustedControllers ?? []).map((c) => ({
    login: c.login,
    role: c.role,
  }));
  const adminServer =
    config.admin?.enabled
      ? new AdminServer({
          runtimeSettings,
          database,
          logger,
          port: config.admin.port,
          llamaServerManager: llamaServerManager ?? undefined,
          aiReviewQueue,
          configControllers,
        })
      : null;

  if (adminServer) {
    await adminServer.start();
  }

  if (config.controlPlane.enabled && authContext.bot.id === authContext.broadcaster.id) {
    logger.warn(
      {
        broadcaster: authContext.broadcaster.login,
        bot: authContext.bot.login,
      },
      "whisper control is enabled, but the bot and broadcaster are the same account; the broadcaster cannot whisper itself",
    );
  }

  return {
    config,
    logger,
    database,
    cooldowns,
    ruleEngine,
    runtimeSettings,
    twitchGateway,
    actionExecutor,
    messageProcessor,
    aiReviewQueue,
    controlPlane,
    adminServer,
    llamaServerManager,
    async close(): Promise<void> {
      await twitchGateway.stop();
      aiReviewQueue.stop();
      if (adminServer) await adminServer.stop();
      if (llamaServerManager) await llamaServerManager.stop();
      database.close();
    },
  };
}

async function loadPromptPacks(config: ConfigSnapshot): Promise<Map<string, PromptSnapshot>> {
  const packNames = new Set([
    config.promptPacks.defaultPack,
    config.ai.promptPack,
    ...config.controlPlane.allowedPromptPacks,
  ]);
  const entries = await Promise.all(
    [...packNames].map(async (packName) => [packName, await readPromptPack(config.paths.promptsDir, packName)] as const),
  );

  return new Map(entries);
}

async function resolveTrustedControllers(
  config: ConfigSnapshot,
  authContext: Awaited<ReturnType<typeof createTwitchAuthContext>>,
): Promise<TrustedController[]> {
  const requestedLogins = new Set(config.controlPlane.trustedControllerLogins.map((login) => login.toLowerCase()));
  const resolved: TrustedController[] = [];

  const roleMap = new Map<string, "admin" | "mod">();
  if (config.controlPlane.trustedControllers) {
    for (const entry of config.controlPlane.trustedControllers) {
      roleMap.set(entry.login.toLowerCase(), entry.role);
    }
  }

  for (const login of requestedLogins) {
    const role = roleMap.get(login) ?? "admin";

    if (login === authContext.broadcaster.login.toLowerCase()) {
      resolved.push({
        userId: authContext.broadcaster.id,
        login: authContext.broadcaster.login,
        displayName: authContext.broadcaster.displayName,
        source: "config",
        role,
      });
      continue;
    }

    const user = await authContext.apiClient.users.getUserByName(login);
    if (!user) {
      throw new Error(`Unable to resolve trusted controller login @${login}.`);
    }

    resolved.push({
      userId: user.id,
      login: user.name,
      displayName: user.displayName,
      source: "config",
      role,
    });
  }

  if (
    config.controlPlane.broadcasterAlwaysAllowed &&
    !resolved.some((controller) => controller.userId === authContext.broadcaster.id)
  ) {
    resolved.push({
      userId: authContext.broadcaster.id,
      login: authContext.broadcaster.login,
      displayName: authContext.broadcaster.displayName,
      source: "broadcaster",
      role: "broadcaster",
    });
  }

  return resolved;
}
