import "../bootstrap-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { loadOrCreateConfig } from "../config.js";
import { createRuntimePaths, expandHome } from "../paths/runtime-paths.js";

async function loadEffectiveConfig() {
  const projectRoot = process.cwd();
  const defaultConfigPath = `${homedir()}/.discord-bot-become-human-2/config.json`;
  const bootstrapConfig = await loadOrCreateConfig(defaultConfigPath);
  const bootstrapPaths = createRuntimePaths(projectRoot, bootstrapConfig);
  const config = await loadOrCreateConfig(bootstrapPaths.configPath);
  return { config, paths: createRuntimePaths(projectRoot, config) };
}

async function main(): Promise<void> {
  const { paths } = await loadEffectiveConfig();
  if (!paths.codexAuthPath) throw new Error("login:codex requires provider: openai-codex in config");
  const authPath = expandHome(paths.codexAuthPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const oauth = openaiCodexProvider().auth.oauth;
    if (!oauth) throw new Error("OpenAI Codex OAuth is not available");
    const credentials = await oauth.login({
      signal: new AbortController().signal,
      notify: (event) => {
        if (event.type === "auth_url") {
          console.log(`\nOpen this URL in your browser:\n${event.url}`);
          if (event.instructions) console.log(event.instructions);
          console.log();
        } else if (event.type === "device_code") {
          console.log(`\nOpen ${event.verificationUri} and enter code ${event.userCode}\n`);
        } else if (event.type === "info") {
          console.log(event.message);
          for (const link of event.links ?? []) console.log(`${link.label ?? "Link"}: ${link.url}`);
        } else {
          console.log(event.message);
        }
      },
      prompt: async (prompt) => askPrompt(rl, prompt),
    });
    const auth = { "openai-codex": credentials };
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
    console.log(`\nCredentials saved to ${authPath}`);
  } finally {
    rl.close();
  }
}

async function askPrompt(rl: ReturnType<typeof createInterface>, prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.log(prompt.message);
    for (const [index, option] of prompt.options.entries()) {
      console.log(`${index + 1}. ${option.label}`);
    }
    const answer = await rl.question("Selection [1]: ");
    const selectedIndex = answer.length === 0 ? 0 : Number.parseInt(answer, 10) - 1;
    const selected = prompt.options[selectedIndex];
    if (!selected) throw new Error("Invalid selection");
    return selected.id;
  }
  return rl.question(`${prompt.message} `);
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
