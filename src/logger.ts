import pino from "pino";

export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    process.env.BOT_LOG_LEVEL ??
    (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "discord-bot-become-human-2" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "apiKey",
      "authorization",
      "headers.authorization",
      "token",
      "refresh",
      "*.apiKey",
      "*.authorization",
      "*.token",
      "*.refresh",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
