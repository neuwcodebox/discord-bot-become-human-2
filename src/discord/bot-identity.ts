import type { BotIdentity } from "../types.js";

export function createBotIdentity(user: {
  id: string;
  username: string;
  globalName: string | null;
  tag: string;
}): BotIdentity {
  return {
    userId: user.id,
    username: user.username,
    globalName: user.globalName,
    tag: user.tag,
    mention: `<@${user.id}>`,
    // Generic role labels are not aliases: they would force replies to other bots.
    names: uniqueNames([user.username, user.globalName, user.tag]),
  };
}

function uniqueNames(values: Array<string | null>): string[] {
  return [
    ...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
  ];
}
