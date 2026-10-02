import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiCodexAgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";

describe("Codex model selection", () => {
  it("reports the installed catalog and deployment steps for an unknown model", async () => {
    const runner = new PiCodexAgentRunner({
      ...defaultConfig,
      llm: {
        provider: "openai-codex",
        model: "unknown-codex-model",
        reasoning: "medium",
        codex: {
          authPath: join(tmpdir(), `dbh2-missing-auth-${randomUUID()}.json`),
          transport: "auto",
        },
      },
    });

    await expect(runner.run({ sessionId: "model-selection", messages: [] })).rejects.toThrow(
      /Unknown openai-codex model: unknown-codex-model\. Installed pi catalog models: .*gpt-6-sol.*npm ci and npm run build/,
    );
  });

  it.each([
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-sol",
  ])("accepts %s from the installed pi catalog", async (model) => {
    const runner = new PiCodexAgentRunner({
      ...defaultConfig,
      llm: {
        provider: "openai-codex",
        model,
        reasoning: "medium",
        codex: {
          authPath: join(tmpdir(), `dbh2-missing-auth-${randomUUID()}.json`),
          transport: "auto",
        },
      },
    });

    await expect(runner.run({ sessionId: "model-selection", messages: [] })).rejects.toThrow(
      "Codex auth is not available",
    );
  });
});
