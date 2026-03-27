import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

import type { RuntimeSettingsStore } from "../control/runtime-settings.js";
import type { BotDatabase } from "../storage/database.js";
import type { LlamaServerManager } from "./llama-server-manager.js";
import type { RuntimeOverrideKey } from "../types.js";

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

interface AdminServerOptions {
  runtimeSettings: RuntimeSettingsStore;
  database: BotDatabase;
  logger: Logger;
  port: number;
  llamaServerManager?: LlamaServerManager | undefined;
}

export class AdminServer {
  private server: http.Server | null = null;
  private readonly options: AdminServerOptions;
  private cachedHtml: string | null = null;

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
        this.options.logger.info({ url: `http://localhost:${this.options.port}` }, "admin panel available");
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

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private serveHtml(res: http.ServerResponse): void {
    if (!this.cachedHtml) {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [
        path.join(thisDir, "public", "index.html"),
        path.resolve(thisDir, "../../../src/admin/public/index.html"),
      ];
      for (const candidate of candidates) {
        try {
          this.cachedHtml = fs.readFileSync(candidate, "utf8");
          break;
        } catch {
          continue;
        }
      }
      if (!this.cachedHtml) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Admin HTML not found");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(this.cachedHtml);
  }

  private handleGetStatus(res: http.ServerResponse): void {
    const settings = this.options.runtimeSettings.getEffectiveSettings();
    const overrides = this.options.runtimeSettings.getOverrides();
    const availablePacks = this.options.runtimeSettings.listAvailablePromptPacks();
    const availableModels = this.options.runtimeSettings.listAvailableModelPresets();
    const llamaServer = this.options.llamaServerManager?.getStatus() ?? null;
    const recentActivity = this.getRecentActivity();

    const body = { settings, overrides, availablePacks, availableModels, llamaServer, recentActivity };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handlePostSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readRequestBody(req);
    let parsed: { key?: string; value?: unknown };
    try {
      parsed = JSON.parse(body) as { key?: string; value?: unknown };
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
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
    this.options.runtimeSettings.reset(ADMIN_ACTOR);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  private getRecentActivity(): Array<Record<string, unknown>> {
    try {
      return this.options.database.getRecentDecisionsForAdmin(10);
    } catch (error) {
      this.options.logger.error({ err: error }, "failed to load recent activity for admin panel");
      return [];
    }
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
