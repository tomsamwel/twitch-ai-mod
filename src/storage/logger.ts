import pino, { type Logger } from "pino";

import type { LogLevel } from "../types.js";

const pad = (n: number) => String(n).padStart(2, "0");

function localIsoTimestamp(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;
  return `,"time":"${now.toLocaleString("sv").replace(" ", "T")}${offset}"`;
}

export function createLogger(level: LogLevel, appName: string): Logger {
  return pino({
    name: appName,
    level,
    base: {
      service: appName,
    },
    timestamp: localIsoTimestamp,
  });
}
