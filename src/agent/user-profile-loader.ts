import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedDiscordMessage } from "../types.js";

export async function loadRelevantUserProfiles(
  workspaceRoot: string,
  messages: NormalizedDiscordMessage[],
  targetMessageIds: string[],
  maxProfiles: number,
): Promise<Array<{ userId: string; profile: string }>> {
  const ids = new Set<string>();
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages.slice(-maxProfiles)) {
    ids.add(message.author.id);
    if (message.replyTo?.authorId) ids.add(message.replyTo.authorId);
    for (const mention of message.mentions) ids.add(mention.id);
  }
  for (const id of targetMessageIds) {
    const message = byMessage.get(id);
    if (message) ids.add(message.author.id);
  }

  const profiles: Array<{ userId: string; profile: string }> = [];
  for (const userId of [...ids].slice(0, maxProfiles)) {
    const profile = await readTextIfExists(join(workspaceRoot, "users", userId, "USER.md"));
    if (profile) profiles.push({ userId, profile });
  }
  return profiles;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
