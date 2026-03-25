import type { OAuthTokenRecord } from "../types.js";

export interface TwitchValidatedToken {
  clientId: string;
  login: string;
  scopes: string[];
  userId: string;
  expiresIn: number;
}

export async function validateTwitchAccessToken(accessToken: string): Promise<TwitchValidatedToken> {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Twitch token validation failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    client_id: string;
    login: string;
    scopes: string[];
    user_id: string;
    expires_in: number;
  };

  return {
    clientId: payload.client_id,
    login: payload.login,
    scopes: payload.scopes,
    userId: payload.user_id,
    expiresIn: payload.expires_in,
  };
}

export function tokenRecordFromValidation(
  validated: TwitchValidatedToken,
  token: {
    accessToken: string;
    refreshToken: string | null;
    scope: string[];
    expiresIn: number | null;
    obtainmentTimestamp: number;
  },
): OAuthTokenRecord {
  return {
    provider: "twitch",
    userId: validated.userId,
    login: validated.login,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    scope: token.scope,
    expiresIn: token.expiresIn,
    obtainmentTimestamp: token.obtainmentTimestamp,
  };
}
