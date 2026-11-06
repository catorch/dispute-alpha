import { redact } from "@da/crypto";

/** Structured JSON logs (R23.1). Every payload passes through redact() so PII never reaches Workers Logs. */
const emit = (level: "info" | "warn" | "error", msg: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ level, msg, ...redact(data), ts: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
