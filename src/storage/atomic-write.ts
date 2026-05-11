import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}
