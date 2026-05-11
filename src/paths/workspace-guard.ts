import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export async function assertInsideWorkspace(workspaceRoot: string, requestedPath: string): Promise<string> {
  const rootReal = await realpath(workspaceRoot);
  const candidate = resolveCandidate(rootReal, requestedPath);
  const existingPath = await nearestExistingPath(candidate);
  const existingReal = await realpath(existingPath);
  assertPathInside(rootReal, existingReal);

  if (existingReal !== candidate) {
    const rest = relative(existingPath, candidate);
    const reconstructed = resolve(existingReal, rest);
    assertPathInside(rootReal, reconstructed);
  }

  return candidate;
}

export async function assertWritablePathInsideWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const rootReal = await realpath(workspaceRoot);
  const candidate = resolveCandidate(rootReal, requestedPath);
  const parent = dirname(candidate);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  assertPathInside(rootReal, parentReal);
  return candidate;
}

function resolveCandidate(rootReal: string, requestedPath: string): string {
  return isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(rootReal, requestedPath);
}

async function nearestExistingPath(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new WorkspacePathError(`No existing parent found for path: ${path}`);
      current = parent;
    }
  }
}

function assertPathInside(rootReal: string, candidate: string): void {
  const rel = relative(rootReal, candidate);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new WorkspacePathError(`Path escapes guild workspace: ${candidate}`);
}
