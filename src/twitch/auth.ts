import { ApiClient } from "@twurple/api";
import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import type { Logger } from "pino";

import type { BotDatabase } from "../storage/database.js";
import type { ConfigSnapshot, OAuthTokenRecord, TwitchIdentity } from "../types.js";
import { validateTwitchAccessToken } from "./token-validation.js";

export interface TwitchAuthContext {
  authProvider: RefreshingAuthProvider;
  apiClient: ApiClient;
  bot: TwitchIdentity;
  broadcaster: TwitchIdentity;
}

function toStoredToken(token: AccessToken, userId: string, login: string): OAuthTokenRecord {
  return {
    provider: "twitch",
    userId,
    login,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    scope: token.scope,
    expiresIn: token.expiresIn,
    obtainmentTimestamp: token.obtainmentTimestamp,
  };
}

export async function createTwitchAuthContext(
  config: ConfigSnapshot,
  database: BotDatabase,
  logger: Logger,
): Promise<TwitchAuthContext> {
  const storedToken = database.getLatestTwitchToken();

  if (!storedToken) {
    throw new Error("No stored Twitch token found. Run `npm run auth:login` first.");
  }

  const authProvider = new RefreshingAuthProvider({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
    redirectUri: config.twitch.redirectUri,
  });

  authProvider.onRefresh(async (userId, token) => {
    try {
      const validated = await validateTwitchAccessToken(token.accessToken);
      database.upsertTwitchToken(toStoredToken(token, userId, validated.login));
      logger.info({ userId, login: validated.login }, "persisted refreshed Twitch token");
    } catch (error) {
      logger.error({ err: error, userId }, "failed to persist refreshed Twitch token");
    }
  });

  authProvider.addUser(storedToken.userId, {
    accessToken: storedToken.accessToken,
    refreshToken: storedToken.refreshToken,
    scope: storedToken.scope,
    expiresIn: storedToken.expiresIn,
    obtainmentTimestamp: storedToken.obtainmentTimestamp,
  });

  const apiClient = new ApiClient({ authProvider });
  const token = await authProvider.getAccessTokenForUser(storedToken.userId, config.twitch.requiredScopes);

  if (!token) {
    throw new Error("Unable to retrieve a valid Twitch user token for the bot account.");
  }

  const validated = await validateTwitchAccessToken(token.accessToken);

  if (validated.userId !== storedToken.userId) {
    throw new Error("Stored Twitch token user changed unexpectedly.");
  }

  if (validated.login.toLowerCase() !== config.twitch.botLogin.toLowerCase()) {
    throw new Error(
      `Stored Twitch token belongs to @${validated.login}, but config/app.yaml expects bot login @${config.twitch.botLogin}.`,
    );
  }

  database.upsertTwitchToken(toStoredToken(token, validated.userId, validated.login));

  const [botUser, broadcasterUser] = await Promise.all([
    apiClient.users.getUserById(validated.userId),
    apiClient.users.getUserByName(config.twitch.broadcasterLogin),
  ]);

  if (!botUser) {
    throw new Error(`Unable to resolve bot user ${validated.userId}.`);
  }

  if (!broadcasterUser) {
    throw new Error(`Unable to resolve broadcaster login @${config.twitch.broadcasterLogin}.`);
  }

  return {
    authProvider,
    apiClient,
    bot: {
      id: botUser.id,
      login: botUser.name,
      displayName: botUser.displayName,
    },
    broadcaster: {
      id: broadcasterUser.id,
      login: broadcasterUser.name,
      displayName: broadcasterUser.displayName,
    },
  };
}
