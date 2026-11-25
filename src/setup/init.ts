import { lstat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateOutput } from "../storage/private-output.js";
import { assertPrivateFile, ensurePrivateDirectory } from "../storage/private-path.js";

export const userTemplateFiles = [
  "01-candidate-profile.md", "02-work-history.md", "03-search-preferences.md",
  "04-source-policy.md", "05-resume-tailoring.md", "06-application-answers.md",
  "07-run-config.md", "08-authentication.md",
] as const;

/** Locate bundled templates in both a source checkout and an installed package. */
export function bundledTemplateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(here, "../.."), resolve(here, "../../..")]) {
    if (existsSync(join(root, "templates", "user", userTemplateFiles[0]))) return root;
  }
  throw new Error("Bundled OpenApply setup templates are missing");
}

/** Create private starter files once; preserve any answers the user already entered. */
export async function initializeUserWorkspace(destination: string, repositoryRoot: string): Promise<string[]> {
  if (!isAbsolute(destination) || !isAbsolute(repositoryRoot)) {
    throw new Error("Setup paths must be absolute");
  }
  await ensurePrivateDirectory(destination);
  const created: string[] = [];
  for (const name of userTemplateFiles) {
    const source = join(repositoryRoot, "templates", "user", name);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`Setup template is not a regular file: ${name}`);
    }
    const target = join(destination, name);
    try {
      await assertPrivateFile(target);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await createPrivateOutput(target, await readFile(source, "utf8"));
    created.push(name);
  }
  return created;
}
