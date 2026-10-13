import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export async function createTestWorkspace(prefix = "dbh2-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
