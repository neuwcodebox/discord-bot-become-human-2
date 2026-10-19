import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentUnavailableError } from "../src/agent/availability.js";
import { CodexUsageMonitor } from "../src/agent/codex-usage.js";
import { fetchCodexUsage } from "../src/agent/codex-usage-client.js";
import { loadCodexAccountCredentials } from "../src/agent/provider.js";
import type { CodexLlmConfig } from "../src/config.js";

vi.mock("../src/agent/provider.js", () => ({
  loadCodexAccountCredentials: vi.fn(async () => ({ accessToken: "private-token", accountId: "account" })),
}));

const fetchMock = vi.fn<typeof fetch>();
const codex: CodexLlmConfig["codex"] = {
  authPath: "/configured/codex-auth.json",
  transport: "auto",
  usageLimit: { enabled: true, minRemainingPercent: 20, pollIntervalMs: 60_000 },
};

function usage(primary = 10, secondary = 30, resetAt = 2_000_000_000) {
  return {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: primary, limit_window_seconds: 18_000, reset_at: resetAt },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604_800, reset_at: resetAt },
    },
  };
}

function monitor(limits: Partial<CodexLlmConfig["codex"]["usageLimit"]> = {}) {
  const instance = new CodexUsageMonitor({ ...codex, usageLimit: { ...codex.usageLimit, ...limits } });
  onTestFinished(() => instance.dispose());
  return instance;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.mocked(loadCodexAccountCredentials).mockClear();
  fetchMock.mockReset().mockImplementation(async () => Response.json(usage()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Codex usage client", () => {
  it("uses only the configured auth file and ordinary account bucket", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...usage(),
        additional_rate_limits: [{ metered_feature: "unrelated-model", rate_limit: { allowed: false } }],
      }),
    );
    const state = await fetchCodexUsage(codex.authPath, new AbortController().signal);
    expect(loadCodexAccountCredentials).toHaveBeenCalledWith(codex.authPath, expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
      signal: expect.any(AbortSignal),
      redirect: "error",
      headers: {
        Authorization: "Bearer private-token",
        "ChatGPT-Account-ID": "account",
        originator: "discord-bot-become-human-2",
      },
    });
    expect(state).toMatchObject({ allowed: true, remainingPercent: 70 });
    expect(state.windows).toEqual([
      { remainingPercent: 90, durationSeconds: 18_000, resetsAt: 2_000_000_000_000 },
      { remainingPercent: 70, durationSeconds: 604_800, resetsAt: 2_000_000_000_000 },
    ]);
  });

  it.each([
    {},
    { rate_limit: null },
    { rate_limit: { primary_window: { used_percent: "bad", limit_window_seconds: 18_000 } } },
    { rate_limit: { primary_window: { used_percent: -1, limit_window_seconds: 18_000 } } },
  ])("rejects missing or invalid quota data", async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(fetchCodexUsage(codex.authPath, new AbortController().signal)).rejects.toThrow(
      "Codex usage is unavailable",
    );
  });

  it("accepts one window without a reset timestamp", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        rate_limit: {
          primary_window: { used_percent: 12.5, limit_window_seconds: 18_000 },
          secondary_window: null,
        },
      }),
    );
    await expect(fetchCodexUsage(codex.authPath, new AbortController().signal)).resolves.toMatchObject({
      allowed: true,
      remainingPercent: 87.5,
    });
  });

  it.each([401, 403, 429, 500])("keeps HTTP %s response bodies private", async (status) => {
    const response = new Response("private-token and private account data", { status });
    const cancel = vi.spyOn(response.body ?? fail(), "cancel");
    fetchMock.mockResolvedValueOnce(response);
    await expect(fetchCodexUsage(codex.authPath, new AbortController().signal)).rejects.toThrow(
      /^Codex usage is unavailable\. Check connectivity and npm run login:codex\.$/,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects oversized usage responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("private-data", { headers: { "content-length": "999999" } }),
    );
    await expect(fetchCodexUsage(codex.authPath, new AbortController().signal)).rejects.toThrow(
      /^Codex usage is unavailable/,
    );
  });
});

describe("subscription usage gate", () => {
  it("does not read credentials or poll when disabled", async () => {
    const instance = monitor({ enabled: false });
    instance.start();
    await instance.assertAvailable();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(instance.current.status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadCodexAccountCredentials).not.toHaveBeenCalled();
  });

  it.each([
    [79, 0, true],
    [80, 80, true],
    [80.01, 0, false],
    [0, 81, false],
    [95, 0, false],
  ])("checks both windows: used %s/%s, allowed=%s", async (primary, secondary, allowed) => {
    fetchMock.mockResolvedValueOnce(Response.json(usage(primary, secondary)));
    const instance = monitor();
    expect(instance.current.allowed).toBe(false);
    await instance.refresh();
    expect(instance.current.allowed).toBe(allowed);
    expect(instance.current.status).toBe(allowed ? "available" : "limited");
  });

  it.each([100, 120])("stops at exhausted usage %s even with a zero reserve", async (used) => {
    fetchMock.mockResolvedValueOnce(Response.json(usage(used, 0)));
    await expect(monitor({ minRemainingPercent: 0 }).assertAvailable()).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
  });

  it.each([
    { rate_limit: { ...usage().rate_limit, allowed: false } },
    { rate_limit: { ...usage().rate_limit, limit_reached: true } },
    { ...usage(), spend_control: { reached: true } },
    { rate_limit: { allowed: false } },
  ])("honors backend blocks regardless of the percentage", async (payload) => {
    fetchMock.mockResolvedValueOnce(Response.json(payload));
    await expect(monitor().assertAvailable()).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("shares in-flight checks and cached results across guilds and requests", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const instance = monitor();
    const checks = [instance.assertAvailable(), instance.assertAvailable(), instance.refresh()];
    pending.resolve(Response.json(usage()));
    await Promise.all(checks);
    await instance.assertAvailable();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed on refresh errors and resumes through polling without new messages", async () => {
    const instance = monitor();
    const listener = vi.fn();
    instance.subscribe(listener);
    await instance.assertAvailable();
    instance.start();
    fetchMock.mockRejectedValueOnce(new Error("private-token"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instance.current).toMatchObject({ status: "unavailable", allowed: false, windows: [] });
    await expect(instance.assertAvailable()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(instance.current.allowed).toBe(true);
    expect(listener.mock.calls.map(([state]) => state.status)).toEqual([
      "checking",
      "available",
      "unavailable",
      "available",
    ]);
  });

  it("refreshes at a reset boundary and never assumes a reset restored quota", async () => {
    const resetsAt = Date.now() / 1000 + 10;
    fetchMock.mockImplementation(async () => Response.json(usage(99, 0, resetsAt)));
    const instance = monitor();
    await instance.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(instance.assertAvailable()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await instance.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls every interval even when the previous response arrived late", async () => {
    const instance = monitor();
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    instance.start();
    await vi.advanceTimersByTimeAsync(1000);
    pending.resolve(Response.json(usage()));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cleans up polling and aborts an in-flight request on shutdown", async () => {
    const instance = monitor();
    const listener = vi.fn();
    instance.subscribe(listener);
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    instance.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve(Response.json(usage()));
    await instance.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(instance.assertAvailable()).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});

function fail(): never {
  throw new Error("Expected response body");
}
