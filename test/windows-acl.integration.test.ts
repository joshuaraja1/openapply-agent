import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWindowsPrivatePath, sealWindowsPrivateChildPath, secureWindowsPrivatePath }
  from "../src/storage/windows-acl.js";

describe.skipIf(process.platform !== "win32")("native Windows private-file ACL", () => {
  it("secures a directory and file, then rejects a shared ACL", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-acl-"));
    const file = join(root, "private.txt");
    const currentUser = execFileSync("whoami", [], { encoding: "utf8" }).trim();
    try {
      await secureWindowsPrivatePath(root);
      await assertWindowsPrivatePath(root);
      await writeFile(file, "fixture");
      await sealWindowsPrivateChildPath(file);
      const ownerScript = `$acl=[System.IO.FileInfo]::new($env:OPENAPPLY_ACL_PATH).GetAccessControl();
        $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
        $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $id.Value`;
      expect(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(ownerScript, "utf16le").toString("base64")], {
        encoding: "utf8", env: { ...process.env, OPENAPPLY_ACL_PATH: file },
      }).trim()).toBe("True");
      execFileSync("icacls", [root, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(sealWindowsPrivateChildPath(file)).rejects.toThrow("ACL is unsafe");
      await secureWindowsPrivatePath(root);
      await secureWindowsPrivatePath(file);
      await assertWindowsPrivatePath(file);
      execFileSync("icacls", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(assertWindowsPrivatePath(file)).rejects.toThrow("ACL is unsafe");
      await expect(sealWindowsPrivateChildPath(file)).rejects.toThrow("ACL is unsafe");
      await secureWindowsPrivatePath(file);
      execFileSync("icacls", [file, "/grant:r", `${currentUser}:(R)`], { stdio: "ignore" });
      await expect(assertWindowsPrivatePath(file)).rejects.toThrow("ACL is unsafe");
    } finally {
      try { execFileSync("icacls", [file, "/grant:r", `${currentUser}:(F)`], { stdio: "ignore" }); }
      catch { /* The file may not exist if setup failed. */ }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
