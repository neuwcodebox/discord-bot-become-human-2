import type { PresenceData } from "discord.js";

export function usagePresence(allowed: boolean): PresenceData {
  return {
    status: allowed ? "online" : "idle",
    activities: [],
  };
}
