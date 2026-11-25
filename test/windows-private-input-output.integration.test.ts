import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile, ensurePrivateDirectory } from "../src/storage/private-path.js";
import { createPrivateOutput } from "../src/storage/private-output.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe.skipIf(process.platform !== "win32")("Windows private onboarding files", () => {
  it("rejects shared inputs and creates owner-only outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-private-files-"));
    const input = join(root, "candidate.md");
    const directory = join(root, "output");
    const output = join(directory, "candidate.json");
    try {
      await secureWindowsPrivatePath(root);
      await writeFile(input, "candidate fixture");
      await secureWindowsPrivatePath(input);
      await assertPrivateFile(input);
      execFileSync("icacls", [input, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(assertPrivateFile(input)).rejects.toThrow("ACL is unsafe");
      await secureWindowsPrivatePath(input);
      await ensurePrivateDirectory(directory);
      await createPrivateOutput(output, "private fixture\n");
      await createPrivateOutput(output, "private fixture\n");
      await assertPrivateFile(output);
      expect(await readFile(output, "utf8")).toBe("private fixture\n");
      await expect(createPrivateOutput(output, "different\n")).rejects.toThrow("differs");
      execFileSync("icacls", [output, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(createPrivateOutput(output, "private fixture\n")).rejects.toThrow("ACL is unsafe");
    } finally {
      await secureWindowsPrivatePath(input).catch(() => {});
      await secureWindowsPrivatePath(output).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
