import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWindowsPrivatePath, secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe.skipIf(process.platform !== "win32")("native Windows private-file ACL", () => {
  it("secures a directory and file, then rejects a shared ACL", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-acl-"));
    try {
      await secureWindowsPrivatePath(root);
      await assertWindowsPrivatePath(root);
      const file = join(root, "private.txt");
      await writeFile(file, "fixture");
      await secureWindowsPrivatePath(file);
      await assertWindowsPrivatePath(file);
      execFileSync("icacls", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(assertWindowsPrivatePath(file)).rejects.toThrow("ACL is unsafe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
