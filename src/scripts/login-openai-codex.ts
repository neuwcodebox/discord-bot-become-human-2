import "../bootstrap-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { loginOpenAICodex } from "@earendil-works/pi-ai/oauth";
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
  const authPath = expandHome(paths.codexAuthPath);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const credentials = await loginOpenAICodex({
      onAuth: (info) => {
        console.log(`\nOpen this URL in your browser:\n${info.url}`);
        if (info.instructions) console.log(info.instructions);
        console.log();
      },
      onPrompt: async (prompt) => rl.question(`${prompt.message} `),
      onProgress: (message) => console.log(message),
    });
    const auth = { "openai-codex": { type: "oauth", ...credentials } };
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
    console.log(`\nCredentials saved to ${authPath}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
