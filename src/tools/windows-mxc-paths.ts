import { realpath } from "node:fs/promises";
import { canonicalPath } from "../paths/canonical-path.js";
import { assertWindowsReadonlyPaths } from "./windows-mxc-policy.js";

/** Validate both configured paths and their junction targets before granting access. */
export async function resolveWindowsReadonlyPaths(input: {
  workspaceRoot: string;
  readonlyPaths: string[];
  protectedPaths: string[];
}): Promise<string[]> {
  const protectedCandidates = [...new Set(input.protectedPaths)];
  const protectedPaths = [
    ...protectedCandidates,
    ...(await Promise.all(protectedCandidates.map((path) => canonicalPath(path, "windows")))),
  ];
  const policy = { ...input, protectedPaths };
  assertWindowsReadonlyPaths(policy);
  const readonlyPaths = [...new Set(await Promise.all(input.readonlyPaths.map((path) => realpath(path))))];
  assertWindowsReadonlyPaths({ ...policy, readonlyPaths });
  return readonlyPaths;
}
