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
import { createPriorityClassifier, workItemCoalesceKey, coalesceWorkItems } from "./runtime/priority-classifier.js";
import { OutboundMessageTracker } from "./runtime/outbound-message-tracker.js";
import { SessionChatterTracker } from "./runtime/session-chatter-tracker.js";
import { ChatterPollService } from "./runtime/chatter-poll-service.js";
import { BotDatabase } from "./storage/database.js";
import { createLogger } from "./storage/logger.js";
import { ensureLlamaServer } from "./scripts/script-support.js";
import type { LlamaServerManager } from "./admin/llama-server-manager.js";
import type {
  ConfigSnapshot,
  PromptSnapshot,
  RuntimeControllerUpsert,
  TrustedController,
  TwitchIdentity,
  TwitchUserResolver,
} from "./types.js";
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

const EXEMPT_USER_CACHE_TTL_MS = 5_000;

export async function createAppServices(): Promise<AppServices> {
  const config = await loadConfig(process.cwd(), { applyLoginEnvOverrides: true });
  const logger = createLogger(config.runtime.logLevel, config.app.name);
  const database = new BotDatabase(config.storage.sqlitePath);
  const authContext = await createTwitchAuthContext(config, database, logger);
  const userResolver = createTwitchUserResolver(authContext);
  await syncRuntimeControllerIdentities(database, userResolver, logger);
  const promptPacks = await loadPromptPacks(config);
  const llamaServerManager = await ensureLlamaServer(config, logger);

  const runtimeSettings = new RuntimeSettingsStore(config, logger, database, promptPacks);
  const aiProviders = new AiProviderRegistry(config, logger);
  await aiProviders.getProvider(aiProviders.createEffectiveConfig(runtimeSettings.getEffectiveSettings()));
  const cooldowns = new CooldownManager(config.cooldowns);
  let exemptUsersCache = new Set<string>();
  let exemptUsersCacheExpiresAt = 0;
  const getExemptUsers = (now = Date.now()): Set<string> => {
    if (now < exemptUsersCacheExpiresAt) {
      return exemptUsersCache;
    }

    exemptUsersCache = new Set(database.listExemptUsers().map((entry) => entry.userLogin.toLowerCase()));
    exemptUsersCacheExpiresAt = now + EXEMPT_USER_CACHE_TTL_MS;
    return exemptUsersCache;
  };
  const isUserExempt = (login: string) => getExemptUsers().has(login.toLowerCase());
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
    workItemCoalesceKey, coalesceWorkItems,
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
  const greetingCooldownMs = config.social?.greetings?.greetingCooldownMs;
  const sessionChatterTracker = new SessionChatterTracker(greetingCooldownMs != null ? {
    isRecentlyGreeted: (userId) => database.isRecentlyGreeted(userId, greetingCooldownMs),
    recordGreeted: (userId) => database.recordGreetedUser(userId),
  } : undefined);
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
    sessionChatterTracker,
    () => aiReviewQueue.getStats().depth,
  );
  aiReviewQueue.start(async (work) => {
    await messageProcessor.processAiReview(work);
  });

  // Poll-path greeting: detect silent viewers who haven't sent a message yet.
  // Enqueues an AI-generated greeting through the same pipeline as first-message greetings.
  let chatterPollService: ChatterPollService | null = null;
  if (config.social?.greetings?.onChatterJoin) {
    chatterPollService = new ChatterPollService(
      authContext.apiClient,
      authContext.broadcaster.id,
      authContext.bot.id,
      sessionChatterTracker,
      config.social.greetings,
      () => aiReviewQueue.getStats().depth,
      (viewers) => {
        messageProcessor.enqueuePollGreeting(viewers, authContext.bot, authContext.broadcaster);
      },
      () => runtimeSettings.getEffectiveSettings().greetingsEnabled,
      logger,
    );
    chatterPollService.start();
    logger.info(
      { intervalMs: config.social.greetings.chatterPollIntervalMs },
      "chatter poll service started",
    );
  }
  const trustedControllers = config.controlPlane.enabled
    ? await resolveTrustedControllers(config, authContext, userResolver)
    : [];
  const controlPlane =
    config.controlPlane.enabled
      ? new WhisperControlPlane(
          config.controlPlane.commandPrefix,
          trustedControllers,
          logger,
          runtimeSettings,
          database,
          twitchGateway,
          aiReviewQueue,
        )
      : null;

  const configControllers = trustedControllers
    .filter((controller) => controller.source === "config")
    .map(({ login, role, userId, displayName }) => ({
      login,
      role,
      userId,
      displayName,
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
          userResolver,
          twitchGateway,
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
      if (chatterPollService) chatterPollService.stop();
      await twitchGateway.stop();
      aiReviewQueue.stop();
      if (adminServer) await adminServer.stop();
      if (llamaServerManager) await llamaServerManager.stop();
      database.close();
    },
  };
}

async function loadPromptPacks(config: ConfigSnapshot): Promise<Map<string, PromptSnapshot>> {
  const requiredPackNames = new Set([
    config.promptPacks.defaultPack,
    config.ai.promptPack,
    ...config.controlPlane.allowedPromptPacks,
  ]);
  const loadedEntries = await Promise.all(
    [...requiredPackNames].map(async (packName) => [packName, await readPromptPack(config.paths.promptsDir, packName)] as const),
  );

  return new Map(loadedEntries);
}

function createTwitchUserResolver(
  authContext: Awaited<ReturnType<typeof createTwitchAuthContext>>,
): TwitchUserResolver {
  return {
    async resolveUserByLogin(login: string) {
      const user = await authContext.apiClient.users.getUserByName(login.toLowerCase());
      if (!user) {
        return null;
      }

      return {
        id: user.id,
        login: user.name,
        displayName: user.displayName,
      };
    },
  };
}

function toRuntimeControllerUpsert(
  identity: TwitchIdentity,
  controller: { role: "admin" | "mod"; addedByLogin: string },
): RuntimeControllerUpsert {
  return {
    login: identity.login,
    userId: identity.id,
    displayName: identity.displayName,
    role: controller.role,
    addedByLogin: controller.addedByLogin,
  };
}

async function syncRuntimeControllerIdentities(
  database: Pick<BotDatabase, "listRuntimeControllers" | "upsertRuntimeController">,
  userResolver: TwitchUserResolver,
  logger: Logger,
): Promise<void> {
  const unresolvedControllers = database.listRuntimeControllers().filter((controller) => controller.userId === null);

  for (const controller of unresolvedControllers) {
    const identity = await userResolver.resolveUserByLogin(controller.login);
    if (!identity) {
      logger.warn(
        { login: controller.login, role: controller.role },
        "runtime controller could not be resolved to a Twitch user ID; leaving it disabled until repaired",
      );
      continue;
    }

    database.upsertRuntimeController(
      toRuntimeControllerUpsert(identity, {
        role: controller.role,
        addedByLogin: controller.addedByLogin,
      }),
    );
    logger.info(
      { login: identity.login, userId: identity.id, role: controller.role },
      "migrated runtime controller to stable Twitch user ID",
    );
  }
}

async function resolveTrustedControllers(
  config: ConfigSnapshot,
  authContext: Awaited<ReturnType<typeof createTwitchAuthContext>>,
  userResolver: TwitchUserResolver,
): Promise<TrustedController[]> {
  const requestedControllers = new Map<string, "admin" | "mod">();
  for (const entry of config.controlPlane.trustedControllers) {
    requestedControllers.set(entry.login.toLowerCase(), entry.role);
  }
  const resolved: TrustedController[] = [];
  for (const [login, role] of requestedControllers) {

    const user = await resolveConfiguredControllerIdentity(login, authContext.broadcaster, userResolver);
    resolved.push({
      userId: user.id,
      login: user.login,
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

async function resolveConfiguredControllerIdentity(
  requestedLogin: string,
  broadcasterIdentity: TwitchIdentity,
  userResolver: TwitchUserResolver,
): Promise<TwitchIdentity> {
  if (requestedLogin === broadcasterIdentity.login.toLowerCase()) {
    return broadcasterIdentity;
  }

  const user = await userResolver.resolveUserByLogin(requestedLogin);
  if (!user) {
    throw new Error(`Unable to resolve trusted controller login @${requestedLogin}.`);
  }

  return user;
}
