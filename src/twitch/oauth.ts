import crypto from "node:crypto";

export function createOAuthState(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createTwitchAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
}): string {
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("force_verify", "true");
  return url.toString();
}
