import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultConfig, parseConfig } from "../src/config.js";
import { sandboxExec } from "../src/tools/sandbox-exec.js";
import { prepareWindowsMxcRequest } from "../src/tools/windows-mxc-prepare.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const runHost = promisify(execFile);

async function fixture() {
  if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex fixture defaults.");
  const runtimeRoot = await createTestWorkspace("dbh2-windows-sandbox-");
  const workspaceRoot = join(runtimeRoot, "guilds", "guild-a", "workspace");
  const otherWorkspace = join(runtimeRoot, "guilds", "guild-b", "workspace");
  const readonlyRoot = await createTestWorkspace("dbh2-windows-tools-");
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(otherWorkspace, { recursive: true })]);
  const authPath = join(runtimeRoot, "codex-auth.json");
  const configPath = join(runtimeRoot, "config.json");
  const instructionPath = join(runtimeRoot, "AGENTS.md");
  const privateRoot = await createTestWorkspace("dbh2-windows-private-");
  const privateFile = join(privateRoot, "private.txt");
  await Promise.all([
    writeFile(authPath, "fixture-auth-secret"),
    writeFile(configPath, "fixture-config-secret"),
    writeFile(instructionPath, "fixture-instructions"),
    writeFile(privateFile, "fixture-personal-secret"),
    writeFile(join(otherWorkspace, "private.txt"), "fixture-other-guild"),
    writeFile(join(readonlyRoot, "readonly.txt"), "readonly-data"),
  ]);
  // Deliberately grant ordinary AppContainers read access. LPAC must still
  // refuse this personal directory; a plain AppContainer test would pass too easily.
  await runHost("icacls.exe", [privateRoot, "/grant", "*S-1-15-2-1:(OI)(CI)(R)"], { windowsHide: true });
  await runHost("icacls.exe", [otherWorkspace, "/grant", "*S-1-15-2-2:(OI)(CI)(RX)"], { windowsHide: true });
  const config = {
    ...defaultConfig,
    runtime: { ...defaultConfig.runtime, rootDir: runtimeRoot },
    llm: { ...defaultConfig.llm, provider: "openai-codex", codex: { ...defaultConfig.llm.codex, authPath } },
    sandbox: { ...defaultConfig.sandbox, timeoutMs: 5000, windows: { readonlyPaths: [readonlyRoot] } },
  };
  // Preserve the discriminated config union without asserting its type.
  const parsedConfig = parseConfig(config);
  const context = { guildId: "guild-a", workspaceRoot, protectedPaths: [instructionPath] };
  const execute = (source: string, args: string[] = [], signal?: AbortSignal) =>
    sandboxExec(context, parsedConfig, { argv: [process.execPath, "-e", source, ...args] }, signal);
  return {
    runtimeRoot,
    workspaceRoot,
    otherWorkspace,
    readonlyRoot,
    privateFile,
    authPath,
    configPath,
    instructionPath,
    context,
    config: parsedConfig,
    execute,
  };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error("Sandbox fixture did not become ready.");
}

// These tests intentionally use the real shipped DLL and real NTFS ACLs.
// They must run on Windows after administrator host preparation.
// DBH2_REQUIRE_WINDOWS_SANDBOX makes a mistaken Linux invocation fail rather than skip.
if (process.env.DBH2_REQUIRE_WINDOWS_SANDBOX === "1" && process.platform !== "win32") {
  throw new Error("Windows sandbox integration verification requires Windows.");
}

describe.skipIf(process.platform !== "win32")("Windows native filesystem sandbox", () => {
  it("permits workspace writes and readonly reads, while blocking private and protected files", async () => {
    const f = await fixture();
    const targets = [
      f.authPath,
      f.configPath,
      f.instructionPath,
      f.privateFile,
      join(f.otherWorkspace, "private.txt"),
    ];
    const result = await f.execute(
      `
      const fs = require('node:fs');
      const targets = JSON.parse(process.argv[1]);
      for (const target of targets) {
        try { fs.readFileSync(target); throw new Error('read escaped'); }
        catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; }
        try { fs.writeFileSync(target, 'escaped'); throw new Error('write escaped'); }
        catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; }
      }
      fs.writeFileSync('result.txt', 'workspace-ok');
      const ro = process.argv[2];
      if (fs.readFileSync(ro, 'utf8') !== 'readonly-data') throw new Error('readonly read failed');
      try { fs.writeFileSync(ro, 'escaped'); throw new Error('readonly write escaped'); }
      catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
      console.log('isolation-ok');
    `,
      [JSON.stringify(targets), join(f.readonlyRoot, "readonly.txt")],
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe("isolation-ok");
    expect(await readFile(join(f.workspaceRoot, "result.txt"), "utf8")).toBe("workspace-ok");
    expect(await readFile(f.authPath, "utf8")).toBe("fixture-auth-secret");
    expect(await readFile(join(f.readonlyRoot, "readonly.txt"), "utf8")).toBe("readonly-data");
  }, 30000);

  it("blocks junction access to another guild", async () => {
    const f = await fixture();
    await symlink(f.otherWorkspace, join(f.workspaceRoot, "outside"), "junction");
    const result = await f.execute(`
      const fs = require('node:fs');
      for (const operation of [() => fs.readFileSync('outside/private.txt'), () => fs.writeFileSync('outside/escaped.txt', 'escaped')]) {
        try { operation(); throw new Error('junction escaped'); }
        catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; }
      }
      console.log('junction-blocked');
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("junction-blocked");
    await expect(access(join(f.otherWorkspace, "escaped.txt"))).rejects.toThrow();
  }, 30000);

  it("rejects a tool-directory junction that exposes another workspace", async () => {
    const f = await fixture();
    const alias = join(f.readonlyRoot, "tool-alias");
    await symlink(dirname(f.workspaceRoot), alias, "junction");
    await expect(
      prepareWindowsMxcRequest(
        f.context,
        {
          ...f.config,
          sandbox: { ...f.config.sandbox, windows: { readonlyPaths: [alias] } },
        },
        [process.execPath],
      ),
    ).rejects.toThrow();
  }, 30000);

  it("preserves argv without shell expansion", async () => {
    const f = await fixture();
    const argv = ["", "a b", 'a"b', "C:\\trailing\\", "&|%USERPROFILE%$()", "한글"];
    const result = await f.execute("console.log(JSON.stringify(process.argv.slice(1)))", argv);
    expect(result.exitCode).toBe(0);
    expect(z.array(z.string()).parse(JSON.parse(result.stdout))).toEqual(argv);
  }, 30000);

  it("restores ACLs after normal exit and timeout", async () => {
    const f = await fixture();
    const before = (await runHost("icacls.exe", [f.workspaceRoot])).stdout;
    const success = await f.execute("console.log('done')");
    expect(success.exitCode).toBe(0);
    expect((await runHost("icacls.exe", [f.workspaceRoot])).stdout).toBe(before);
    const timeoutConfig = { ...f.config, sandbox: { ...f.config.sandbox, timeoutMs: 100 } };
    const result = await sandboxExec(f.context, timeoutConfig, {
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    });
    expect(result.timedOut).toBe(true);
    expect((await runHost("icacls.exe", [f.workspaceRoot])).stdout).toBe(before);
  }, 30000);

  it("terminates descendants and restores ACLs before cancellation returns", async () => {
    const f = await fixture();
    const before = (await runHost("icacls.exe", [f.workspaceRoot])).stdout;
    const controller = new AbortController();
    const execution = f.execute(
      `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync('child.pid', String(child.pid));
      fs.writeFileSync('ready.txt', 'ready');
      setInterval(() => {}, 1000);
    `,
      [],
      controller.signal,
    );
    const aborted = expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await waitForFile(join(f.workspaceRoot, "ready.txt"));
    const childPid = z.coerce
      .number()
      .int()
      .positive()
      .parse(await readFile(join(f.workspaceRoot, "child.pid"), "utf8"));
    assert.doesNotThrow(() => process.kill(childPid, 0));
    controller.abort();
    await aborted;
    expect((await runHost("icacls.exe", [f.workspaceRoot])).stdout).toBe(before);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  }, 30000);

  it("isolates concurrent guild executions and their ACL lifetimes", async () => {
    const f = await fixture();
    const source = `
      const fs = require('node:fs');
      fs.writeFileSync('own.txt', 'own');
      try { fs.readFileSync(process.argv[1]); throw new Error('guild escaped'); }
      catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error; }
      setTimeout(() => console.log('guild-ok'), 100);
    `;
    const [a, b] = await Promise.all([
      f.execute(source, [join(f.otherWorkspace, "private.txt")]),
      sandboxExec({ ...f.context, guildId: "guild-b", workspaceRoot: f.otherWorkspace }, f.config, {
        argv: [process.execPath, "-e", source, join(f.workspaceRoot, "own.txt")],
      }),
    ]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout.trim()).toBe("guild-ok");
    expect(b.stdout.trim()).toBe("guild-ok");
  }, 30000);
});
