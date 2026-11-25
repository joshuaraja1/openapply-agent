import { describe, expect, it, vi } from "vitest";
import { checkOwnedBrowser } from "../src/browser/doctor.js";

describe("owned browser readiness", () => {
  it("reports a missing Chromium without touching the profile", async () => {
    const launch = vi.fn();
    await expect(checkOwnedBrowser("/private/profile", { executablePath: () => "/missing/chromium",
      checkFile: async () => { throw new Error("missing"); }, launch })).rejects.toThrow("browser:install");
    expect(launch).not.toHaveBeenCalled();
  });

  it("checks one blank page, closes the runtime, and emits no session data", async () => {
    const closePage = vi.fn(async () => {});
    const closeRuntime = vi.fn(async () => {});
    const goto = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ context: {
      newPage: async () => ({ goto, title: async () => "", close: closePage }),
      browser: () => ({ version: () => "123.0" }),
    }, close: closeRuntime })) as never;
    const ticks = [100, 249];
    const result = await checkOwnedBrowser("/private/profile", {
      executablePath: () => "/installed/chromium", checkFile: async () => {},
      launch, now: () => ticks.shift() ?? 249,
    });
    expect(result).toEqual({ status: "ready", startupMs: 149, browserVersion: "123.0" });
    expect(launch).toHaveBeenCalledWith({ profileDirectory: "/private/profile", headless: true });
    expect(goto).toHaveBeenCalledWith("about:blank");
    expect(closePage).toHaveBeenCalledOnce();
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("profile");
  });

  it("releases the profile after a readiness page fails", async () => {
    const closeRuntime = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ context: {
      newPage: async () => { throw new Error("renderer crashed"); },
    }, close: closeRuntime })) as never;
    await expect(checkOwnedBrowser("/private/profile", {
      executablePath: () => "/installed/chromium", checkFile: async () => {}, launch,
    })).rejects.toThrow("renderer crashed");
    expect(closeRuntime).toHaveBeenCalledOnce();
  });
});
