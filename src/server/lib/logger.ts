/**
 * Tiny logger. Messages below the current level are dropped.
 * The level comes from LOG_LEVEL (debug | info | warn | error), default "info",
 * so debug output (raw model responses, diffs) only appears with LOG_LEVEL=debug.
 * Never pass tokens or secrets in `fields`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function currentLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  return level && level in LEVEL_ORDER ? (level as LogLevel) : "info";
}

function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLogLevel()]) return;
  const line = fields ? `[${level}] ${message} ${JSON.stringify(fields)}` : `[${level}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
