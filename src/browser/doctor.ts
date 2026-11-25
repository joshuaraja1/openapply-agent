import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { launchBrowser, type BrowserRuntime } from "./runtime.js";

export interface BrowserDoctorResult {
  status: "ready";
  startupMs: number;
  browserVersion: string;
}

/** Checks the dedicated local runtime without reading cookies or account data. */
export async function checkOwnedBrowser(
  profileDirectory: string,
  dependencies: { executablePath?: () => string; checkFile?: (path: string) => Promise<void>;
    launch?: typeof launchBrowser; now?: () => number } = {},
): Promise<BrowserDoctorResult> {
  const executablePath = (dependencies.executablePath ?? (() => chromium.executablePath()))();
  try {
    await (dependencies.checkFile ?? access)(executablePath);
  } catch {
    throw new Error("Local Chromium is missing; run npm run browser:install");
  }
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const runtime: BrowserRuntime = await (dependencies.launch ?? launchBrowser)({
    profileDirectory, headless: true,
  });
  try {
    const page = await runtime.context.newPage();
    try {
      await page.goto("about:blank");
      await page.title();
    } finally {
      await page.close();
    }
    return { status: "ready", startupMs: Math.round(now() - started),
      browserVersion: runtime.context.browser()?.version() ?? "unknown" };
  } finally {
    await runtime.close();
  }
}
