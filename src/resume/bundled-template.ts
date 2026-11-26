import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the shipped template from this package, independently of the caller's cwd. */
export async function readBundledJakeTemplate(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  // The source module lives in src/resume; the built module in dist/src/resume.
  for (const root of [resolve(moduleDirectory, "../.."), resolve(moduleDirectory, "../../..")]) {
    let manifest: { name?: string };
    try {
      manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (manifest.name !== "openapply-agent") continue;
    return readFile(join(root, "templates", "resume", "main.tex"), "utf8");
  }
  throw new Error("Cannot locate the OpenApply package containing the bundled resume template");
}
