import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledTemplateRoot, initializeUserWorkspace, userTemplateFiles } from "../src/setup/init.js";
import { assertPrivateFile } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("private first-run template setup", () => {
  it("locates the bundled templates independently of the current directory", async () => {
    const root = bundledTemplateRoot();
    expect((await readFile(join(root, "templates", "user", userTemplateFiles[0]), "utf8")).length)
      .toBeGreaterThan(100);
  });
  it("creates private templates once and preserves the user's edited answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-"));
    const sourceDirectory = join(root, "templates", "user");
    const destination = join(root, "onboarding");
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      await mkdir(sourceDirectory, { recursive: true });
      for (const name of userTemplateFiles) await writeFile(join(sourceDirectory, name), `template ${name}`);
      expect(await initializeUserWorkspace(destination, root)).toEqual(userTemplateFiles);
      for (const name of userTemplateFiles) await assertPrivateFile(join(destination, name));
      const edited = join(destination, userTemplateFiles[0]);
      await writeFile(edited, "private candidate answers");
      expect(await initializeUserWorkspace(destination, root)).toEqual([]);
      expect(await readFile(edited, "utf8")).toBe("private candidate answers");
      await expect(initializeUserWorkspace("relative", root)).rejects.toThrow("absolute");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 90_000 : 30_000);
});
