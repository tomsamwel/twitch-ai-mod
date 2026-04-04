import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { z } from "zod";

import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import type { BotDatabase } from "../storage/database.js";
import type { LlamaServerManager } from "./llama-server-manager.js";
import type { AiReviewQueueStats } from "../runtime/ai-review-queue.js";
import type {
  RuntimeControllerIdentifier,
  RuntimeControllerRecord,
  RuntimeOverrideKey,
  TrustedController,
  TwitchUserResolver,
} from "../types.js";

const VALID_OVERRIDE_KEYS: readonly RuntimeOverrideKey[] = [
  "aiEnabled",
  "aiModerationEnabled",
  "socialRepliesEnabled",
  "dryRun",
  "liveModerationEnabled",
  "promptPack",
  "modelPreset",
];

const ADMIN_ACTOR = { userId: "admin", login: "local-admin" };
const TERMINAL_LINK_OPEN = "\u001B]8;;";
const TERMINAL_LINK_SEPARATOR = "\u0007";
const TERMINAL_LINK_CLOSE = "\u001B]8;;\u0007";

interface AiReviewQueueLike {
  getStats(): AiReviewQueueStats;
}

type ConfigController = Pick<TrustedController, "login" | "role" | "userId" | "displayName">;

interface AdminServerOptions {
  runtimeSettings: RuntimeSettingsStore;
  database: BotDatabase;
  logger: Logger;
  port: number;
  llamaServerManager?: LlamaServerManager | undefined;
  aiReviewQueue?: AiReviewQueueLike | undefined;
  configControllers?: ConfigController[] | undefined;
  userResolver: TwitchUserResolver;
}

function formatTerminalLink(url: string, label = url): string {
  if (!process.stdout.isTTY) {
    return url;
  }
  return `${TERMINAL_LINK_OPEN}${url}${TERMINAL_LINK_SEPARATOR}${label}${TERMINAL_LINK_CLOSE}`;
}

function printStartupLink(label: string, url: string): void {
  process.stdout.write(`\n${label}: ${formatTerminalLink(url)}\n\n`);
}

export class AdminServer {
  private server: http.Server | null = null;
  private readonly options: AdminServerOptions;

  public constructor(options: AdminServerOptions) {
    this.options = options;
  }

  public async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.options.logger.error({ err: error }, "admin server request error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(this.options.port, "127.0.0.1", () => {
        const adminUrl = `http://127.0.0.1:${this.options.port}`;
        this.options.logger.info({ url: adminUrl }, "admin panel available");
        printStartupLink("Open admin panel", adminUrl);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return this.serveHtml(res);
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return this.handleGetStatus(res);
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      return this.handlePostSettings(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      return this.handlePostReset(res);
    }
    if (req.method === "GET" && url.pathname === "/api/activity") {
      return this.handleGetActivity(url, res);
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      return this.handleGetAudit(url, res);
    }
    if (req.method === "GET" && url.pathname === "/api/user") {
      return this.handleGetUser(url, res);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      return this.handleGetStats(res);
    }
    if (req.method === "GET" && url.pathname === "/api/exemptions") {
      return this.handleGetExemptions(res);
    }
    if (req.method === "POST" && url.pathname === "/api/exemptions") {
      return this.handlePostExemptions(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/exemptions/remove") {
      return this.handlePostExemptionsRemove(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/blocked-terms") {
      return this.handleGetBlockedTerms(res);
    }
    if (req.method === "POST" && url.pathname === "/api/blocked-terms") {
      return this.handlePostBlockedTerms(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/blocked-terms/remove") {
      return this.handlePostBlockedTermsRemove(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return this.handleGetHealth(res);
    }
    if (req.method === "GET" && url.pathname === "/api/controllers") {
      return this.handleGetControllers(res);
    }
    if (req.method === "POST" && url.pathname === "/api/controllers") {
      return this.handlePostControllers(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/controllers/remove") {
      return this.handlePostControllersRemove(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/controllers/role") {
      return this.handlePostControllersRole(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/purge/user") {
      return this.handlePostPurgeUser(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/purge/all") {
      return this.handlePostPurgeAll(res);
    }
    if (req.method === "GET" && url.pathname === "/api/chatters") {
      return this.handleGetChatters(url, res);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private serveHtml(res: http.ServerResponse): void {
    // Always read fresh from disk so edits are reflected without restart
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(thisDir, "public", "index.html"),
      path.resolve(thisDir, "../../../src/admin/public/index.html"),
    ];
    let html: string | null = null;
    for (const candidate of candidates) {
      try {
        html = fs.readFileSync(candidate, "utf8");
        break;
      } catch {
        continue;
      }
    }
    if (!html) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Admin HTML not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private handleGetStatus(res: http.ServerResponse): void {
    const settings = this.options.runtimeSettings.getEffectiveSettings();
    const overrides = this.options.runtimeSettings.getOverrides();
    const availablePacks = this.options.runtimeSettings.listAvailablePromptPacks();
    const availableModels = this.options.runtimeSettings.listAvailableModelPresets();
    const llamaServer = this.options.llamaServerManager?.getStatus() ?? null;
    const aiQueue = this.options.aiReviewQueue?.getStats() ?? null;
    const recentActivity = this.getRecentActivity();

    const body = { settings, overrides, availablePacks, availableModels, llamaServer, aiQueue, recentActivity };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handlePostSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ key?: string; value?: unknown }>(req, res);
    if (!parsed) {
      return;
    }

    if (!parsed.key || !VALID_OVERRIDE_KEYS.includes(parsed.key as RuntimeOverrideKey)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid key. Valid keys: ${VALID_OVERRIDE_KEYS.join(", ")}` }));
      return;
    }

    try {
      this.options.runtimeSettings.setOverride(
        parsed.key as RuntimeOverrideKey,
        parsed.value as boolean | string,
        ADMIN_ACTOR,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid value" }));
    }
  }

  private handlePostReset(res: http.ServerResponse): void {
    const summary = this.options.runtimeSettings.reset(ADMIN_ACTOR);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...summary }));
  }

  private handleGetActivity(url: URL, res: http.ServerResponse): void {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "25"), 100);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const filters: Record<string, string> = {};
    for (const key of ["chatter", "outcome", "stage", "after"] as const) {
      const value = url.searchParams.get(key);
      if (value) filters[key] = value;
    }
    const result = this.options.database.getRecentDecisionsPaginated(limit, offset, filters);
    this.jsonResponse(res, 200, result);
  }

  private handleGetAudit(url: URL, res: http.ServerResponse): void {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "25"), 100);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const result = this.options.database.getControlAuditLog(limit, offset);
    this.jsonResponse(res, 200, result);
  }

  private handleGetUser(url: URL, res: http.ServerResponse): void {
    const login = url.searchParams.get("login");
    if (!login) {
      this.jsonResponse(res, 400, { error: "login parameter is required" });
      return;
    }
    const result = this.options.database.getUserHistory(login);
    this.jsonResponse(res, 200, result);
  }

  private handleGetStats(res: http.ServerResponse): void {
    const sinceIso = new Date(Date.now() - 3_600_000).toISOString();
    const stats = this.options.database.getHourlyStats(sinceIso);
    const aiQueue = this.options.aiReviewQueue?.getStats() ?? null;
    const llamaServer = this.options.llamaServerManager?.getStatus() ?? null;
    this.jsonResponse(res, 200, { stats, aiQueue, llamaServer });
  }

  private handleGetExemptions(res: http.ServerResponse): void {
    this.jsonResponse(res, 200, this.options.database.listExemptUsers());
  }

  private async handlePostExemptions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ login?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.login) {
      this.jsonResponse(res, 400, { error: "login is required" });
      return;
    }
    const added = this.options.database.addExemptUser(parsed.login, ADMIN_ACTOR.login);
    this.jsonResponse(res, 200, { ok: true, added });
  }

  private async handlePostExemptionsRemove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ login?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.login) {
      this.jsonResponse(res, 400, { error: "login is required" });
      return;
    }
    const removed = this.options.database.removeExemptUser(parsed.login);
    this.jsonResponse(res, 200, { ok: true, removed });
  }

  private handleGetBlockedTerms(res: http.ServerResponse): void {
    this.jsonResponse(res, 200, this.options.database.listRuntimeBlockedTerms());
  }

  private async handlePostBlockedTerms(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ term?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.term) {
      this.jsonResponse(res, 400, { error: "term is required" });
      return;
    }
    const added = this.options.database.addRuntimeBlockedTerm(parsed.term, ADMIN_ACTOR.login);
    this.jsonResponse(res, 200, { ok: true, added });
  }

  private async handlePostBlockedTermsRemove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ term?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.term) {
      this.jsonResponse(res, 400, { error: "term is required" });
      return;
    }
    const removed = this.options.database.removeRuntimeBlockedTerm(parsed.term);
    this.jsonResponse(res, 200, { ok: true, removed });
  }

  private handleGetHealth(res: http.ServerResponse): void {
    const llamaServer = this.options.llamaServerManager?.getStatus() ?? null;
    const aiQueue = this.options.aiReviewQueue?.getStats() ?? null;
    this.jsonResponse(res, 200, { llamaServer, aiQueue });
  }

  private handleGetControllers(res: http.ServerResponse): void {
    const configControllers = (this.options.configControllers ?? []).map((controller) =>
      this.toControllerResponse(controller, "config"),
    );
    const runtimeControllers = this.options.database.listRuntimeControllers().map((controller) =>
      this.toControllerResponse(controller, "runtime"),
    );
    this.jsonResponse(res, 200, { config: configControllers, runtime: runtimeControllers });
  }

  private async handlePostControllers(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ login?: string; role?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.login) {
      this.jsonResponse(res, 400, { error: "login is required" });
      return;
    }
    const role = parsed.role === "mod" ? "mod" : "admin";
    const identity = await this.options.userResolver.resolveUserByLogin(parsed.login);
    if (!identity) {
      this.jsonResponse(res, 400, { error: `Unable to resolve Twitch user @${parsed.login}.` });
      return;
    }
    const controller = this.options.database.upsertRuntimeController({
      login: identity.login,
      userId: identity.id,
      displayName: identity.displayName,
      role,
      addedByLogin: ADMIN_ACTOR.login,
    });
    this.jsonResponse(res, 200, { ok: true, controller });
  }

  private async handlePostControllersRemove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<RuntimeControllerIdentifier>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.login && !parsed?.userId) {
      this.jsonResponse(res, 400, { error: "login or userId is required" });
      return;
    }
    const removed = this.options.database.removeRuntimeController(parsed);
    this.jsonResponse(res, 200, { ok: true, removed });
  }

  private async handlePostControllersRole(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<RuntimeControllerIdentifier & { role?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if ((!parsed?.login && !parsed?.userId) || !parsed.role) {
      this.jsonResponse(res, 400, { error: "login or userId and role are required" });
      return;
    }
    if (parsed.role !== "admin" && parsed.role !== "mod") {
      this.jsonResponse(res, 400, { error: "role must be admin or mod" });
      return;
    }
    const updated = this.options.database.updateRuntimeControllerRole(
      parsed,
      parsed.role,
    );
    this.jsonResponse(res, 200, { ok: true, updated });
  }

  private async handlePostPurgeUser(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody<{ login?: string }>(req, res);
    if (!parsed) {
      return;
    }
    if (!parsed?.login) {
      this.jsonResponse(res, 400, { error: "login is required" });
      return;
    }
    const result = this.options.database.purgeUserHistory(parsed.login);
    this.jsonResponse(res, 200, { ok: true, ...result });
  }

  private handlePostPurgeAll(res: http.ServerResponse): void {
    const result = this.options.database.purgeOperationalData();
    this.jsonResponse(res, 200, { ok: true, ...result });
  }

  private handleGetChatters(url: URL, res: http.ServerResponse): void {
    const prefix = url.searchParams.get("prefix") ?? "";
    if (prefix.length < 1) {
      this.jsonResponse(res, 200, []);
      return;
    }
    const logins = this.options.database.getKnownChatterLogins(prefix);
    this.jsonResponse(res, 200, logins);
  }

  private jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async readJsonBody<T>(req: http.IncomingMessage, res: http.ServerResponse): Promise<T | null> {
    const parsed = parseJsonBody<T>(await readRequestBody(req));
    if (parsed) {
      return parsed;
    }

    this.jsonResponse(res, 400, { error: "Invalid JSON" });
    return null;
  }

  private async readValidatedJsonBody<S extends z.ZodTypeAny>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    schema: S,
  ): Promise<z.infer<S> | null> {
    const parsed = await this.readJsonBody<unknown>(req, res);
    if (parsed === null) {
      return null;
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }

    this.jsonResponse(res, 400, { error: validated.error.issues[0]?.message ?? "Invalid request body" });
    return null;
  }

  private getRecentActivity(): Array<Record<string, unknown>> {
    try {
      return this.options.database.getRecentDecisionsForAdmin(10);
    } catch (error) {
      this.options.logger.error({ err: error }, "failed to load recent activity for admin panel");
      return [];
    }
  }

  private toControllerResponse(
    controller: ConfigController | RuntimeControllerRecord,
    source: "config" | "runtime",
  ) {
    return {
      login: controller.login,
      userId: controller.userId ?? null,
      displayName: controller.displayName ?? null,
      role: controller.role,
      resolved: controller.userId !== null,
      source,
    };
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.once("end", () => resolve(Buffer.concat(chunks).toString()));
    req.once("error", reject);
  });
}

function parseJsonBody<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
