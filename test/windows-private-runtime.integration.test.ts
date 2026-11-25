import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchBrowser } from "../src/browser/runtime.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { assertWindowsPrivatePath, secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe.skipIf(process.platform !== "win32")("Windows private runtime paths", () => {
  it("protects the browser profile and its process lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runtime-acl-"));
    try {
      await secureWindowsPrivatePath(root);
      const profileDirectory = join(root, "profile");
      const close = vi.fn(async () => {});
      const launch = vi.fn(async () => ({ close })) as unknown as
        NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
      const browser = await launchBrowser({ profileDirectory, launch });
      try {
        await assertWindowsPrivatePath(profileDirectory);
        await assertWindowsPrivatePath(`${profileDirectory}.lock`);
      } finally { await browser.close(); }
      expect(close).toHaveBeenCalledOnce();
      await expect(stat(`${profileDirectory}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  it("stores encrypted state only under private Windows ACLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-state-acl-"));
    const statePath = join(root, "state.enc.json");
    const currentUser = execFileSync("whoami", [], { encoding: "utf8" }).trim();
    try {
      await secureWindowsPrivatePath(root);
      const store = new EncryptedApplicationStateStore<{ stage: string }>(statePath, Buffer.alloc(32, 7));
      expect(await store.compareAndSwap("job-1", undefined, { stage: "ready" })).toBe(1);
      await assertWindowsPrivatePath(statePath);
      expect(await readFile(statePath, "utf8")).not.toContain("ready");
      expect(await store.read("job-1")).toEqual({ version: 1, state: { stage: "ready" } });
      execFileSync("icacls", [statePath, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      await expect(store.read("job-1")).rejects.toThrow("ACL is unsafe");
    } finally {
      try { execFileSync("icacls", [statePath, "/grant:r", `${currentUser}:(F)`], { stdio: "ignore" }); }
      catch { /* The file may not exist if setup failed. */ }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
