import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchBrowser } from "../src/browser/runtime.js";

const directories: string[] = [];
async function testProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openapply-browser-"));
  directories.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { mode: 0o700 });
  return profile;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("persistent browser runtime", () => {
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("persists cookies across a real browser restart", async () => {
    const directory = await testProfile();
    const first = await launchBrowser({ profileDirectory: directory, headless: true });
    await first.context.addCookies([{
      name: "session-test", value: "present", domain: "example.test", path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
    }]);
    await first.close();
    const second = await launchBrowser({ profileDirectory: directory, headless: true });
    expect(await second.context.cookies("https://example.test")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session-test", value: "present" }),
    ]));
    await second.close();
  });

  it("locks one profile until the browser closes", async () => {
    const directory = await testProfile();
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ close })) as unknown as NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
    const browser = await launchBrowser({ profileDirectory: directory, launch });
    await expect(launchBrowser({ profileDirectory: directory, launch })).rejects.toThrow();
    await browser.close();
    expect(close).toHaveBeenCalledOnce();
    const next = await launchBrowser({ profileDirectory: directory, launch });
    await browser.close();
    expect(await stat(`${directory}.lock`)).toBeDefined();
    await next.close();
  });

  it("releases the lock when launch fails", async () => {
    const directory = await testProfile();
    const launch = vi.fn(async () => { throw new Error("renderer failed"); }) as unknown as NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
    await expect(launchBrowser({ profileDirectory: directory, launch })).rejects.toThrow("renderer failed");
    await expect(stat(`${directory}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a crash lock until explicitly recovered", async () => {
    const directory = await testProfile();
    await mkdir(`${directory}.lock`);
    const launch = vi.fn(async () => ({ close: async () => {} })) as unknown as NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
    await expect(launchBrowser({ profileDirectory: directory, launch })).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    await rm(`${directory}.lock`, { recursive: true });
  });

  it.skipIf(process.platform === "win32")("rejects a shared profile directory", async () => {
    const directory = await testProfile();
    await chmod(directory, 0o755);
    await expect(launchBrowser({ profileDirectory: directory })).rejects.toThrow("private");
  });
});
