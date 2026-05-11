import pino, { type LoggerOptions } from "pino";

const prettyTransport =
  process.env.NODE_ENV === "test" || process.env.LOG_FORMAT === "json"
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: process.env.NO_COLOR === undefined,
          ignore: "pid,hostname",
          translateTime: "SYS:standard",
        },
      };

const loggerOptions: LoggerOptions = {
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
};

if (prettyTransport) {
  loggerOptions.transport = prettyTransport;
}

export const logger = pino(loggerOptions);

export function childLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
