import assert from "node:assert/strict";
import test from "node:test";

import { EventSubConnectionMonitor } from "../src/twitch/eventsub-connection-monitor.js";
import type { EventSubConnectionStatus } from "../src/types.js";

test("EventSubConnectionMonitor marks disconnects and becomes stale after the grace period", async () => {
  const staleStatuses: EventSubConnectionStatus[] = [];
  const monitor = new EventSubConnectionMonitor(1, true, (status) => {
    staleStatuses.push(status);
  });

  monitor.markDisconnected(new Error("[1006]"));
  const disconnected = monitor.getStatus();

  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.stale, false);
  assert.equal(disconnected.disconnectCount, 1);
  assert.equal(disconnected.lastDisconnectError, "[1006]");

  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(staleStatuses.length, 1);
  assert.equal(staleStatuses[0]?.stale, true);
  assert.equal(monitor.getStatus().stale, true);

  monitor.stop();
});

test("EventSubConnectionMonitor clears the stale timer when the socket reconnects", async () => {
  const staleStatuses: EventSubConnectionStatus[] = [];
  const monitor = new EventSubConnectionMonitor(1, true, (status) => {
    staleStatuses.push(status);
  });

  monitor.markDisconnected(new Error("[1006]"), "2026-04-06T13:52:23.000Z");
  const reconnect = monitor.markConnected("2026-04-06T13:52:25.500Z");
  const connected = monitor.getStatus();

  assert.equal(reconnect.reconnectedAfterMs, 2_500);
  assert.equal(connected.connected, true);
  assert.equal(connected.stale, false);
  assert.equal(connected.lastDisconnectError, null);

  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(staleStatuses.length, 0);

  monitor.stop();
});
