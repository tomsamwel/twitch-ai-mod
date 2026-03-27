import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

interface LlamaServerManagerOptions {
  logger: Logger;
  modelTag: string;
  port: number;
  ctxSize?: number;
  checkpointEvery?: number;
  dataDir: string;
}

interface LlamaServerStatus {
  running: boolean;
  pid: number | null;
  port: number;
  model: string;
  startedAt: string | null;
}

function resolveGgufBlobPath(modelTag: string): string {
  const manifestDir = path.join(os.homedir(), ".ollama/models/manifests/registry.ollama.ai/library");
  const tagPath = modelTag.replace(":", "/");
  const manifestPath = path.join(manifestDir, tagPath);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Ollama model manifest not found at ${manifestPath}. Run \`ollama pull ${modelTag}\` first.`,
    );
  }

  let manifest: { layers: Array<{ mediaType: string; digest: string }> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    throw new Error(`Failed to parse Ollama manifest at ${manifestPath}. The file may be corrupted.`);
  }

  const modelLayer = manifest.layers.find((layer) => layer.mediaType.includes("model"));

  if (!modelLayer) {
    throw new Error(`No model layer found in manifest for ${modelTag}`);
  }

  const blobPath = path.join(os.homedir(), ".ollama/models/blobs", modelLayer.digest.replace(":", "-"));

  if (!fs.existsSync(blobPath)) {
    throw new Error(`Model blob not found at ${blobPath}`);
  }

  return blobPath;
}

export class LlamaServerManager {
  private child: ChildProcess | null = null;
  private startedAt: string | null = null;
  private readonly pidFilePath: string;
  private readonly port: number;
  private readonly modelTag: string;
  private readonly ctxSize: number;
  private readonly checkpointEvery: number;
  private readonly logger: Logger;

  public constructor(options: LlamaServerManagerOptions) {
    this.logger = options.logger;
    this.modelTag = options.modelTag;
    this.port = options.port;
    this.ctxSize = options.ctxSize ?? 2048;
    this.checkpointEvery = options.checkpointEvery ?? 256;
    this.pidFilePath = path.join(options.dataDir, ".llama-server.pid");
  }

  public async start(): Promise<void> {
    await this.killStaleProcess();

    const blobPath = resolveGgufBlobPath(this.modelTag);

    this.logger.info({ model: this.modelTag, port: this.port, blob: blobPath }, "starting llama-server");

    this.child = spawn(
      "llama-server",
      [
        "-m", blobPath,
        "--port", String(this.port),
        "-c", String(this.ctxSize),
        "-ngl", "999",
        "--checkpoint-every-n-tokens", String(this.checkpointEvery),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    this.child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line) this.logger.debug({ source: "llama-server" }, line);
      }
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        if (line) this.logger.debug({ source: "llama-server" }, line);
      }
    });

    this.child.on("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "llama-server exited");
      this.child = null;
      this.startedAt = null;
      this.removePidFile();
    });

    if (this.child.pid) {
      fs.writeFileSync(this.pidFilePath, String(this.child.pid), "utf8");
    }

    this.startedAt = new Date().toISOString();
    await this.waitForReady();
  }

  public async stop(): Promise<void> {
    if (!this.child) return;

    this.logger.info("stopping llama-server");
    this.child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child) {
          this.logger.warn("llama-server did not exit in time, sending SIGKILL");
          this.child.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      this.child?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.child = null;
    this.startedAt = null;
  }

  public getStatus(): LlamaServerStatus {
    return {
      running: this.child !== null && this.child.exitCode === null,
      pid: this.child?.pid ?? null,
      port: this.port,
      model: this.modelTag,
      startedAt: this.startedAt,
    };
  }

  private async waitForReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    const url = `http://localhost:${this.port}/health`;

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          this.logger.info({ port: this.port }, "llama-server is ready");
          return;
        }
      } catch {
        // Expected while server is still loading the model.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`llama-server did not become ready within ${timeoutMs}ms`);
  }

  private async killStaleProcess(): Promise<void> {
    let stalePid: number;
    try {
      stalePid = Number.parseInt(fs.readFileSync(this.pidFilePath, "utf8").trim(), 10);
    } catch {
      return;
    }

    if (Number.isNaN(stalePid)) {
      this.removePidFile();
      return;
    }

    try {
      process.kill(stalePid, 0);
    } catch {
      this.removePidFile();
      return;
    }

    this.logger.info({ pid: stalePid }, "killing stale llama-server process");
    process.kill(stalePid, "SIGTERM");
    this.removePidFile();

    // Wait for the process to exit so the port is released.
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(stalePid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.logger.warn({ pid: stalePid }, "stale llama-server did not exit after 5s, proceeding anyway");
  }

  private removePidFile(): void {
    try {
      fs.unlinkSync(this.pidFilePath);
    } catch {
      // ENOENT is fine — file was already cleaned up.
    }
  }
}
