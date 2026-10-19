import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentUnavailableError } from "../src/agent/availability.js";
import { CodexUsageMonitor } from "../src/agent/codex-usage.js";
import { loadCodexCredentials } from "../src/agent/provider.js";
import { PiCodexAgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";

vi.mock("../src/agent/provider.js", () => ({
  loadCodexAccountCredentials: vi.fn(async () => ({ accessToken: "token", accountId: "account" })),
  loadCodexCredentials: vi.fn(async () => ({ apiKey: "token" })),
}));
vi.mock("@earendil-works/pi-ai/api/openai-codex-responses", () => ({ streamSimple: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.mocked(streamSimple).mockReset();
  vi.mocked(loadCodexCredentials).mockClear();
  fetchMock.mockReset().mockImplementation(async () => quota(10));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function quota(used: number) {
  return Response.json({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: used, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
    },
  });
}

function runner() {
  if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex defaults");
  const config = {
    ...defaultConfig,
    llm: {
      ...defaultConfig.llm,
      codex: {
        ...defaultConfig.llm.codex,
        usageLimit: { enabled: true, minRemainingPercent: 20, pollIntervalMs: 60_000 },
      },
    },
  };
  const usageMonitor = new CodexUsageMonitor(config.llm.codex);
  const instance = new PiCodexAgentRunner(config, null, usageMonitor);
  onTestFinished(() => usageMonitor.dispose());
  return { instance, usageMonitor };
}

function assistant(toolCall: boolean): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    timestamp: Date.now(),
    stopReason: toolCall ? "toolUse" : "stop",
    content: toolCall
      ? [{ type: "toolCall", id: "tool-1", name: "test_tool", arguments: {} }]
      : [{ type: "text", text: "reply" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("Codex subscription runner boundary", () => {
  it("blocks before any model request or generation credentials are loaded", async () => {
    fetchMock.mockImplementation(async () => quota(90));
    const { instance } = runner();
    await expect(instance.run({ sessionId: "blocked", messages: [] })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    expect(instance.isAvailable()).toBe(false);
    expect(streamSimple).not.toHaveBeenCalled();
    expect(loadCodexCredentials).not.toHaveBeenCalled();
  });

  it("aborts a running background generation when a poll detects low quota", async () => {
    const { instance, usageMonitor } = runner();
    vi.mocked(streamSimple).mockImplementation((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const stop = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            ...assistant(false),
            stopReason: "aborted",
            content: [],
          },
        });
        stream.end();
      };
      options?.signal?.addEventListener("abort", stop, { once: true });
      if (options?.signal?.aborted) stop();
      return stream;
    });
    const result = instance.run({
      sessionId: "dream:guild:phase1",
      messages: [{ role: "user", content: "test" }],
    });
    const rejected = expect(result).rejects.toBeInstanceOf(AgentUnavailableError);
    await vi.waitFor(() => expect(streamSimple).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_001);
    fetchMock.mockImplementation(async () => quota(95));
    await usageMonitor.refresh();
    await rejected;
    expect(vi.mocked(streamSimple).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it.each(["before_tool", "before_next_model"])("rechecks quota %s in the agent loop", async (boundary) => {
    vi.useFakeTimers();
    const { instance } = runner();
    const execute = vi.fn(async () => {
      if (boundary === "before_next_model") {
        vi.setSystemTime(Date.now() + 60_001);
        fetchMock.mockImplementation(async () => quota(90));
      }
      return { content: [{ type: "text" as const, text: "done" }], details: {} };
    });
    vi.mocked(streamSimple).mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      if (boundary === "before_tool") {
        vi.setSystemTime(Date.now() + 60_001);
        fetchMock.mockImplementation(async () => quota(90));
      }
      const message = assistant(true);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
      return stream;
    });
    await expect(
      instance.run({
        sessionId: "loop",
        messages: [{ role: "user", content: "test" }],
        tools: [
          {
            name: "test_tool",
            label: "Test",
            description: "Test boundary",
            parameters: Type.Object({}),
            execute,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(streamSimple).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(boundary === "before_tool" ? 0 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
