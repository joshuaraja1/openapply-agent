import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { startHandoffUi } from "../src/application/handoff-ui.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";
import { startSetupUi } from "../src/setup/ui.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => (document.activeElement as HTMLElement).id);
}

async function pressTabAndExpect(page: Page, id: string): Promise<void> {
  await page.keyboard.press("Tab");
  expect(await focusedId(page)).toBe(id);
}

const pending: ApplicationCheckpoint = {
  jobId: "synthetic:123", officialUrl: "https://example.invalid/jobs/123",
  stage: "waiting-human", blocker: "Enter a synthetic required answer",
  packagePath: "/synthetic/application.json", updatedAt: "2026-11-25T18:00:00.000Z",
};

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("local keyboard accessibility", () => {
  it("keeps setup sections and actions reachable with labels and live status", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-keyboard-setup-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const context = await chromium.launchPersistentContext(join(root, "browser"), { headless: true });
    const ui = await startSetupUi({ destination: join(root, "onboarding"), repositoryRoot: process.cwd() });
    try {
      const page = await context.newPage();
      await page.goto(ui.url);
      await expect.poll(() => page.locator("#files button").count()).toBe(8);
      expect(await page.locator("#message").getAttribute("aria-live")).toBe("polite");
      expect(await page.locator("#readiness").getAttribute("role")).toBe("status");
      expect(await page.locator("#runtime-status").getAttribute("role")).toBe("status");
      expect(await page.getByLabel("Template contents").count()).toBe(1);
      expect(await page.getByLabel("Job title").count()).toBe(1);
      expect(await page.getByLabel("Job description").count()).toBe(1);
      await pressTabAndExpect(page, ""); // First dynamic navigation button has no id.
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Candidate profile");
      for (let index = 1; index < 8; index++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toContain(
          ["Work history", "Search preferences", "Source policy", "Résumé tailoring",
            "Application answers", "Run configuration", "Authentication"][index - 1]);
      }
      await pressTabAndExpect(page, "editor");
      await pressTabAndExpect(page, "save");
      await pressTabAndExpect(page, "compile");
      await page.keyboard.press("Shift+Tab");
      expect(await focusedId(page)).toBe("save");
      await page.locator("#preview-run").focus();
      await page.keyboard.press("Tab");
      expect(await focusedId(page)).not.toBe("preview-run");
      await page.locator("#readiness-check").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => page.locator("#readiness").textContent())
        .not.toBe("Profile readiness has not been checked.");
    } finally { await ui.close(); await context.close(); await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it("moves focus into a newly added handoff answer and allows keyboard continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-keyboard-handoff-"));
    const context = await chromium.launchPersistentContext(join(root, "browser"), { headless: true });
    let continued = false;
    const ui = await startHandoffUi({ jobId: pending.jobId,
      loadCheckpoint: async () => pending,
      resume: async () => { continued = true; } });
    try {
      const page = await context.newPage();
      await page.goto(ui.url);
      await expect.poll(() => page.locator("#status").textContent())
        .toContain("Application status: waiting-human");
      expect(await page.locator("#status").getAttribute("aria-live")).toBe("polite");
      expect(await page.getByLabel("Question or field label").count()).toBe(1);
      expect(await page.getByLabel("Your answer").count()).toBe(1);
      expect(await page.getByLabel(/I reviewed this response/).count()).toBe(1);
      await page.keyboard.press("Tab");
      expect(await page.locator(".field").first().evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator(".value").first().evaluate((element) => element === document.activeElement)).toBe(true);
      await pressTabAndExpect(page, "add");
      await page.keyboard.press("Enter");
      expect(await page.locator(".field").count()).toBe(2);
      expect(await page.locator(".field").nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator(".value").nth(1).evaluate((element) => element === document.activeElement)).toBe(true);
      await pressTabAndExpect(page, "add");
      await page.keyboard.press("Tab");
      expect(await focusedId(page)).toBe("authorize");
      await pressTabAndExpect(page, "resume");
      await page.keyboard.press("Shift+Tab");
      expect(await focusedId(page)).toBe("authorize");
      await page.keyboard.press("Space");
      await pressTabAndExpect(page, "resume");
      await page.keyboard.press("Tab");
      expect(await focusedId(page)).not.toBe("resume");
      await page.locator("#resume").focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => continued).toBe(true);
    } finally { await ui.close(); await context.close(); await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
