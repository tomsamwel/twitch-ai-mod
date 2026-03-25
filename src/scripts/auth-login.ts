import { createServer } from "node:http";
import { URL } from "node:url";

import { RefreshingAuthProvider } from "@twurple/auth";

import { loadConfig } from "../config/load-config.js";
import { BotDatabase } from "../storage/database.js";
import { createLogger } from "../storage/logger.js";
import { createOAuthState, createTwitchAuthorizationUrl } from "../twitch/oauth.js";
import { validateTwitchAccessToken } from "../twitch/token-validation.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = createLogger(config.runtime.logLevel, `${config.app.name}-auth`);
  const database = new BotDatabase(config.storage.sqlitePath);
  const state = createOAuthState();
  const authUrl = createTwitchAuthorizationUrl({
    clientId: config.twitch.clientId,
    redirectUri: config.twitch.redirectUri,
    scope: config.twitch.requiredScopes,
    state,
  });

  const authProvider = new RefreshingAuthProvider({
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
    redirectUri: config.twitch.redirectUri,
  });

  logger.info(
    {
      redirectUri: config.twitch.redirectUri,
      botLogin: config.twitch.botLogin,
      broadcasterLogin: config.twitch.broadcasterLogin,
      scopes: config.twitch.requiredScopes,
    },
    "starting local Twitch OAuth callback server",
  );
  console.log(`Open this URL in your browser:\n${authUrl}`);

  await new Promise<void>((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", config.twitch.redirectUri);

      if (requestUrl.pathname !== new URL(config.twitch.redirectUri).pathname) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        response.statusCode = 400;
        response.end(`OAuth error: ${error}`);
        server.close();
        reject(new Error(`Twitch OAuth returned error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        response.statusCode = 400;
        response.end("Invalid OAuth callback payload.");
        server.close();
        reject(new Error("OAuth callback did not include a valid code/state pair."));
        return;
      }

      void (async () => {
        try {
          const userId = await authProvider.addUserForCode(code);
          const token = await authProvider.getAccessTokenForUser(userId, config.twitch.requiredScopes);

          if (!token) {
            throw new Error("Unable to fetch the exchanged Twitch token.");
          }

          const validated = await validateTwitchAccessToken(token.accessToken);
          database.upsertTwitchToken({
            provider: "twitch",
            userId: validated.userId,
            login: validated.login,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            scope: token.scope,
            expiresIn: token.expiresIn,
            obtainmentTimestamp: token.obtainmentTimestamp,
          });

          response.statusCode = 200;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Twitch authentication complete. You can return to the terminal.");
          logger.info({ userId: validated.userId, login: validated.login }, "stored Twitch OAuth token");
          server.close();
          resolve();
        } catch (exchangeError) {
          response.statusCode = 500;
          response.end("Failed to exchange Twitch authorization code.");
          server.close();
          reject(exchangeError);
        }
      })();
    });

    server.on("error", reject);
    server.listen(config.twitch.oauthPort, config.twitch.oauthHost);
  });

  database.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
