import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function existingCanonicalPath(candidate: string): Promise<string | undefined> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Resolve existing ancestors too, so a not-yet-created auth file stays protected. */
export async function canonicalPath(
  candidate: string,
  style: "native" | "windows" = "native",
): Promise<string> {
  const paths = style === "windows" ? path.win32 : path;
  const suffix: string[] = [];
  let ancestor = candidate;
  while (true) {
    try {
      return paths.join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (!missing(error)) throw error;
      // A dangling link must not be treated as an ordinary missing filename.
      // Its eventual target could be inside an approved tool directory.
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) {
          throw new Error("Protected path contains an unresolved symbolic link.");
        }
      } catch (statError) {
        if (!missing(statError)) throw statError;
      }
      const parent = paths.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(paths.basename(ancestor));
      ancestor = parent;
    }
  }
}
