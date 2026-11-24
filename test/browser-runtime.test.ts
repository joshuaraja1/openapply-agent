import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchBrowser } from "../src/browser/runtime.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("persistent browser runtime", () => {
  it.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("persists cookies across a real browser restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-browser-"));
    directories.push(directory);
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
    const directory = await mkdtemp(join(tmpdir(), "openapply-browser-"));
    directories.push(directory);
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ close })) as unknown as NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
    const browser = await launchBrowser({ profileDirectory: directory, launch });
    expect(await readFile(join(directory, ".openapply.lock"), "utf8")).toBe(String(process.pid));
    await expect(launchBrowser({ profileDirectory: directory, launch })).rejects.toThrow("already in use");
    await browser.close();
    expect(close).toHaveBeenCalledOnce();
    const next = await launchBrowser({ profileDirectory: directory, launch });
    await next.close();
  });

  it("releases the lock when launch fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-browser-"));
    directories.push(directory);
    const launch = vi.fn(async () => { throw new Error("renderer failed"); }) as unknown as NonNullable<Parameters<typeof launchBrowser>[0]["launch"]>;
    await expect(launchBrowser({ profileDirectory: directory, launch })).rejects.toThrow("renderer failed");
    await expect(readFile(join(directory, ".openapply.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
