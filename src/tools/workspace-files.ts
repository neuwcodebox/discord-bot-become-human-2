import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { assertInsideWorkspace, assertWritablePathInsideWorkspace } from "../paths/workspace-guard.js";
import type { ToolContext } from "../types.js";

export async function workspaceRead(context: ToolContext, path: string): Promise<string> {
  const safePath = await assertInsideWorkspace(context.workspaceRoot, path);
  return readFile(safePath, "utf8");
}

export async function workspaceWrite(
  context: ToolContext,
  path: string,
  contents: string,
): Promise<{ path: string }> {
  const safePath = await assertWritablePathInsideWorkspace(context.workspaceRoot, path);
  await mkdir(dirname(safePath), { recursive: true });
  await writeFile(safePath, contents, "utf8");
  return { path: relative(context.workspaceRoot, safePath) };
}

export async function workspaceSearch(
  context: ToolContext,
  query: string,
  options: { maxResults?: number } = {},
): Promise<Array<{ path: string; line: number; text: string }>> {
  const root = await assertInsideWorkspace(context.workspaceRoot, ".");
  const maxResults = options.maxResults ?? 50;
  const results: Array<{ path: string; line: number; text: string }> = [];
  await searchDirectory(root, query.toLowerCase(), root, results, maxResults);
  return results;
}

async function searchDirectory(
  root: string,
  query: string,
  current: string,
  results: Array<{ path: string; line: number; text: string }>,
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults) return;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (entry.name.startsWith(".") && entry.name !== ".cursor" && entry.name !== ".dream_cursor") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await searchDirectory(root, query, path, results, maxResults);
    } else if (entry.isFile()) {
      const text = await readFile(path, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.toLowerCase().includes(query)) {
          results.push({ path: relative(root, path), line: index + 1, text: line });
          if (results.length >= maxResults) return;
        }
      }
    }
  }
}
