import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPrivateFile, assertSameFileIdentity, ensurePrivateDirectory, readPrivateFile }
  from "../src/storage/private-path.js";
import { createPrivateOutput } from "../src/storage/private-output.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe.skipIf(process.platform !== "win32")("Windows private onboarding files", () => {
  it("rejects shared inputs and creates owner-only outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-private-files-"));
    const input = join(root, "candidate.md");
    const shared = join(root, "shared");
    const sharedInput = join(shared, "candidate.md");
    const directory = join(root, "output");
    const output = join(directory, "candidate.json");
    try {
      await secureWindowsPrivatePath(root);
      await writeFile(input, "candidate fixture");
      await secureWindowsPrivatePath(input);
      await assertPrivateFile(input);
      expect(await readPrivateFile(input)).toBe("candidate fixture");
      await mkdir(shared);
      await secureWindowsPrivatePath(shared);
      await writeFile(sharedInput, "candidate fixture");
      await secureWindowsPrivatePath(sharedInput);
      execFileSync("icacls", [shared, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      await expect(assertPrivateFile(sharedInput)).rejects.toThrow("ACL is unsafe");
      await secureWindowsPrivatePath(shared);
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
      await secureWindowsPrivatePath(shared).catch(() => {});
      await secureWindowsPrivatePath(output).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects a directory entry replaced under a shared grandparent", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-grandparent-"));
    const grandparent = join(root, "shared");
    const privateParent = join(grandparent, "private");
    const path = join(privateParent, "candidate.md");
    try {
      await secureWindowsPrivatePath(root);
      await mkdir(grandparent);
      await secureWindowsPrivatePath(grandparent);
      await mkdir(privateParent);
      await secureWindowsPrivatePath(privateParent);
      await writeFile(path, "original");
      await secureWindowsPrivatePath(path);
      execFileSync("icacls", [grandparent, "/grant", "*S-1-1-0:(M)"], { stdio: "ignore" });
      expect(await readPrivateFile(path)).toBe("original");
      const pinned = await open(path, "r");
      let identity;
      try {
        identity = await pinned.stat();
      } finally { await pinned.close(); }
      // Windows can prevent renaming a directory while a child handle is open.
      await rename(privateParent, join(grandparent, "moved"));
      await mkdir(privateParent);
      await secureWindowsPrivatePath(privateParent);
      await writeFile(path, "replacement");
      await secureWindowsPrivatePath(path);
      const named = await lstat(path);
      expect(() => assertSameFileIdentity(identity, named)).toThrow("changed");
    } finally {
      await secureWindowsPrivatePath(grandparent).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
