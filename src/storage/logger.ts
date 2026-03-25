import pino, { type Logger } from "pino";

import type { LogLevel } from "../types.js";

export function createLogger(level: LogLevel, appName: string): Logger {
  return pino({
    name: appName,
    level,
    base: {
      service: appName,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
