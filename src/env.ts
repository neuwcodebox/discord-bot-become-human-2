import { existsSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { projectRootFromImportMeta } from "./paths/runtime-paths.js";

export function resolveProjectDotenvPath(importMetaUrl: string): string {
  return join(projectRootFromImportMeta(importMetaUrl), ".env");
}

export function loadDotenvFile(path: string): boolean {
  if (!existsSync(path)) return false;

  const result = loadDotenv({ path, override: false, quiet: true });
  if (result.error) throw result.error;
  return true;
}

export function loadProjectDotenv(importMetaUrl: string): boolean {
  return loadDotenvFile(resolveProjectDotenvPath(importMetaUrl));
}
