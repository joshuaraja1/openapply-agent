import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { startHandoffUi } from "../src/application/handoff-ui.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";
import { startSetupUi } from "../src/setup/ui.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";

const fenced = (tag: string, value: unknown) => `\u0060\u0060\u0060${tag}\n${JSON.stringify(value)}\n\u0060\u0060\u0060\n`;

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("synthetic first-run browser journey", () => {
  it("compiles a profile, saves runtime, exports state, and resumes a human handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-first-run-browser-"));
    const privateRoot = join(root, "private");
    await ensurePrivateDirectory(privateRoot);
    const destination = join(privateRoot, "onboarding");
    const key = randomBytes(32);
    const browserDoctor = vi.fn(async () => ({ status: "ready" as const,
      startupMs: 1, browserVersion: "synthetic" }));
    const ui = await startSetupUi({ destination, repositoryRoot: process.cwd(),
      stateRoot: privateRoot, browserDoctor,
      stateSecretStore: { get: async () => key.toString("base64"), put: async () => {}, delete: async () => {} } });
    const browser = await chromium.launch({ headless: true });
    let handoff: Awaited<ReturnType<typeof startHandoffUi>> | undefined;
    try {
      const page = await browser.newPage();
      await page.goto(ui.url);
      const templates = [
        fenced("openapply-identity-json", { version: 1,
          identity: { fullName: "Fixture Candidate", location: "Dallas, TX",
            email: "candidate@example.invalid", phone: "555-0100" },
          authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
          education: [] }),
        fenced("openapply-history-json", { version: 1, skills: { languages: ["Python"] },
          experience: [{ employer: "Fixture", title: "Engineer", employmentType: "Intern",
            start: "2025", end: "2026", claims: [{ id: "claim-1", claim: "Built Python services",
              skills: ["Python"], evidence: [{ source: "fixture", uri: "private:history" }],
              status: "user-confirmed", allowedUses: ["matching", "resume"] }] }],
          projects: [], quarantinedClaims: [] }),
        fenced("openapply-search-json", { version: 1, targetRoles: ["Software Engineer"],
          workArrangements: { preferred: ["Remote"], accepted: ["Remote"] },
          compensation: { preferredBaseFloor: 0 },
          applicationPolicy: { dailyTarget: 2, dailyHardCap: 3, requireFinalApproval: true } }),
      ];
      for (const [index, content] of templates.entries()) {
        await page.locator("#files button").nth(index).click();
        await page.locator("#editor").fill(content);
        await page.locator("#save").click();
        await expect.poll(() => page.locator("#message").textContent()).toContain("Saved privately");
      }
      await page.locator("#compile").click();
      await expect.poll(() => page.locator("#readiness").textContent()).toContain("compiled and current");
      // The saved policy must appear without a manual refresh after compiling section 03.
      await expect.poll(() => page.locator("#runtime-policy").textContent()).toContain("2 applications/day target");
      await page.locator("#runtime-overleaf").fill("https://www.overleaf.com/project/0123456789abcdef01234567");
      await page.locator("#runtime-company").fill("Fixture");
      await page.locator("#runtime-identifier").fill("fixture");
      await page.locator("#runtime-save").click();
      await expect.poll(() => page.locator("#runtime-save-status").textContent())
        .toContain("Private runtime settings saved");
      await page.locator("#browser-doctor").click();
      await expect.poll(() => page.locator("#runtime-status").textContent())
        .toContain("Owned Chromium started");
      expect(browserDoctor).toHaveBeenCalledOnce();

      const config = JSON.parse(await readFile(join(privateRoot, "queue-runner.json"), "utf8")) as
        { queuePath: string; discoveryStatePath: string };
      await writeFile(config.queuePath, JSON.stringify({ queue: [] }), { mode: 0o600 });
      await writeFile(config.discoveryStatePath, JSON.stringify({ jobs: {} }), { mode: 0o600 });
      const store = new EncryptedApplicationStateStore(join(privateRoot, "applications.enc.json"), key);
      await store.compareAndSwap("fixture:1", undefined, { stage: "waiting-human", email: "candidate@example.invalid" });
      await page.locator("#state-confirmation").fill("EXPORT");
      await page.locator('[data-state-action="export"]').click();
      await expect.poll(() => page.locator("#state-status").textContent()).toContain("exported");
      expect(await readFile(join(privateRoot, "state-export.json"), "utf8"))
        .toContain("candidate@example.invalid");

      let checkpoint: ApplicationCheckpoint = { jobId: "fixture:1",
        officialUrl: "https://jobs.example.invalid/fixture", stage: "waiting-human",
        blocker: "Answer the required question", packagePath: join(privateRoot, "fixture-package.json"),
        updatedAt: "2026-11-26T00:00:00.000Z" };
      const resume = vi.fn(async (_saved: ApplicationCheckpoint, answers: { field: string; value: string }[]) => {
        expect(answers).toEqual([{ field: "Required question", value: "Candidate answer" }]);
        checkpoint = { ...checkpoint, stage: "submitted" };
      });
      handoff = await startHandoffUi({ jobId: checkpoint.jobId, jobLabel: "Fixture — Engineer",
        loadCheckpoint: async () => checkpoint, resume });
      await page.goto(handoff.url);
      await expect.poll(() => page.locator("#status").textContent()).toContain("waiting-human");
      await page.locator(".field").fill("Required question");
      await page.locator(".value").fill("Candidate answer");
      await page.locator("#authorize").check();
      await page.locator("#resume").click();
      await expect.poll(() => page.locator("#status").textContent()).toContain("submitted");
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      await handoff?.close();
      await browser.close();
      await ui.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
