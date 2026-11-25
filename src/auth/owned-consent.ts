import { userInfo } from "node:os";
import { join } from "node:path";
import { launchBrowser, type BrowserRuntime } from "../browser/runtime.js";
import type { AuthenticationPolicy } from "./schema.js";

export function assertMailboxConsentUrl(url: string, policy: AuthenticationPolicy): void {
  const parsed = new URL(url);
  const expectedHost = policy.emailVerification.provider === "gmail"
    ? "accounts.google.com" : "login.microsoftonline.com";
  if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost
    || parsed.port || parsed.username || parsed.password) {
    throw new Error("Mailbox consent URL has an unexpected origin");
  }
}

export async function openOwnedMailboxConsent(url: string, policy: AuthenticationPolicy,
  launch: typeof launchBrowser = launchBrowser): Promise<BrowserRuntime> {
  assertMailboxConsentUrl(url, policy);
  const runtime = await launch({
    profileDirectory: join(userInfo().homedir, ".openapply-agent", "browser-profile"),
    headless: false,
  });
  try {
    const page = await runtime.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return runtime;
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
