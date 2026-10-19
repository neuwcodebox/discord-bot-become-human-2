import { describe, expect, it } from "vitest";
import { usagePresence } from "../src/discord/usage-presence.js";

describe("subscription presence", () => {
  it.each([
    { status: "available", allowed: true, presence: "online" },
    { status: "disabled", allowed: true, presence: "online" },
    { status: "limited", allowed: false, presence: "idle" },
    { status: "checking", allowed: false, presence: "idle" },
    { status: "unavailable", allowed: false, presence: "idle" },
  ] as const)("shows $presence without activity text when $status", ({ allowed, presence }) => {
    expect(usagePresence(allowed)).toEqual({ status: presence, activities: [] });
  });
});
