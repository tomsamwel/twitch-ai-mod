import type { EventSubConnectionStatus } from "../types.js";

export class EventSubConnectionMonitor {
  private staleTimer: NodeJS.Timeout | null = null;
  private readonly status: EventSubConnectionStatus;

  public constructor(
    reconnectGraceSeconds: number,
    exitOnStall: boolean,
    private readonly onStale: (status: EventSubConnectionStatus) => void,
  ) {
    this.status = {
      connected: false,
      reconnectGraceSeconds,
      exitOnStall,
      stale: false,
      disconnectCount: 0,
      lastConnectAt: null,
      lastDisconnectAt: null,
      lastDisconnectError: null,
    };
  }

  public markConnected(atIso = new Date().toISOString()): { reconnectedAfterMs: number | null } {
    const reconnectedAfterMs = this.status.lastDisconnectAt
      ? Math.max(0, new Date(atIso).getTime() - new Date(this.status.lastDisconnectAt).getTime())
      : null;

    this.status.connected = true;
    this.status.stale = false;
    this.status.lastConnectAt = atIso;
    this.status.lastDisconnectError = null;
    this.clearTimer();

    return { reconnectedAfterMs };
  }

  public markDisconnected(error?: Error, atIso = new Date().toISOString()): void {
    this.status.connected = false;
    this.status.stale = false;
    this.status.disconnectCount += 1;
    this.status.lastDisconnectAt = atIso;
    this.status.lastDisconnectError = error?.message ?? null;
    this.clearTimer();

    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.status.connected) {
        return;
      }

      this.status.stale = true;
      this.onStale(this.getStatus());
    }, this.status.reconnectGraceSeconds * 1000);
  }

  public stop(): void {
    this.clearTimer();
  }

  public getStatus(): EventSubConnectionStatus {
    return { ...this.status };
  }

  private clearTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }
}
