import { describe, expect, it, vi } from "vitest";
import { bindAgentRunControl } from "../src/agent/run-control.js";
import type { AgentRunControl } from "../src/types.js";

describe("pi run control", () => {
  it("binds cancellation to the current agent and refuses steering after cancellation or disposal", () => {
    const controller = new AbortController();
    const agent = { abort: vi.fn(), steer: vi.fn() };
    let control: AgentRunControl | undefined;
    const dispose = bindAgentRunControl(agent, {
      sessionId: "test",
      messages: [],
      signal: controller.signal,
      onControlReady: (ready) => {
        control = ready;
      },
    });
    expect(control?.steer("observed correction")).toBe(true);
    expect(agent.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "observed correction" }],
      }),
    );
    controller.abort();
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(control?.steer("late message")).toBe(false);
    dispose();
    expect(control?.steer("another late message")).toBe(false);
    expect(agent.steer).toHaveBeenCalledOnce();
  });

  it("removes the abort listener when a run ends so it cannot cancel later work", () => {
    const controller = new AbortController();
    const agent = { abort: vi.fn(), steer: vi.fn() };
    let control: AgentRunControl | undefined;
    const dispose = bindAgentRunControl(agent, {
      sessionId: "test",
      messages: [],
      signal: controller.signal,
      onControlReady: (ready) => {
        control = ready;
      },
    });
    dispose();
    controller.abort();
    expect(agent.abort).not.toHaveBeenCalled();
    expect(control?.steer("late")).toBe(false);
  });

  it("does not start a run whose signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const agent = { abort: vi.fn(), steer: vi.fn() };
    const ready = vi.fn();
    expect(() =>
      bindAgentRunControl(agent, {
        sessionId: "test",
        messages: [],
        signal: controller.signal,
        onControlReady: ready,
      }),
    ).toThrow();
    expect(ready).not.toHaveBeenCalled();
  });
});
