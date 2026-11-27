import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("staging application facts review", () => {
  it("sends only reviewed facts and an explicit No sponsorship answer", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const html = (await readFile("cloud/staging-login/index.html", "utf8"))
        .replace('<script type="module" src="/login.js"></script>', "");
      const source = await readFile("cloud/staging-login/onboarding.js", "utf8");
      await page.setContent(html);
      await page.evaluate(() => {
        Object.defineProperty(crypto, "randomUUID", {
          value: () => "22222222-2222-4222-8222-222222222222",
        });
        (window as unknown as { submitted: unknown[] }).submitted = [];
        window.fetch = async (url, init) => url === "/api/candidates/plan"
          ? new Response(JSON.stringify({ status: "active", plan: "free-grant",
            accessUntil: "2099-01-01T00:00:00Z" }), { status: 200 })
          : ((window as unknown as { submitted: unknown[] }).submitted.push(JSON.parse(String(init?.body))),
            new Response("{}", { status: 201 }));
      });
      await page.addScriptTag({ type: "module", content: `${source}\nattachCandidateSetup({ getIdToken: () => "test.token.value" });` });
      await page.locator("#candidate-setup").waitFor({ state: "visible" });
      await page.locator('[name="careerStage"]').selectOption("new-graduate");
      for (const [name, value] of Object.entries({ targetRoles: "Software engineer",
        locations: "Chicago", schoolOrEmployer: "Example University",
        graduationOrExperience: "May 2026", fullName: "Avery Example",
        applicationEmail: "avery@example.test", phone: "555-0100",
        currentLocation: "Chicago", authorizedCountries: "United States",
        educationFacts: "BS Computer Science, Example University | Python" })) {
        await page.locator(`[name="${name}"]`).fill(value);
      }
      await page.locator('[name="sponsorship"]').selectOption("no");
      await page.locator('[name="masterResume"]').setInputFiles({ name: "resume.pdf",
        mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\ntest") });
      await page.getByRole("button", { name: "Add project" }).click();
      await page.locator('.project-entry [name="name"]').fill('Search project');
      await page.locator('.project-entry [name="claims"]').fill('Built a search tool');
      await page.getByRole("button", { name: "Review my answers" }).click();
      expect(await page.locator('#setup-status').textContent()).toContain('Each fact needs its own accurate skill tags');
      expect(await page.locator('#setup-review').isVisible()).toBe(false);
      await page.locator('.project-entry [name="claims"]').fill('Built a search tool | TypeScript, SQL');
      await page.getByRole("button", { name: "Review my answers" }).click();
      expect(await page.locator("#setup-summary").textContent()).toContain("Needs sponsorship: No");
      expect(await page.locator("#setup-summary").textContent()).toContain("Built a search tool [skills used: TypeScript, SQL]");
      for (const id of ["review-confirmed", "storage-consent", "automation-consent"]) {
        await page.locator(`#${id}`).check();
      }
      await page.locator("#setup-save").click();
      await page.waitForFunction(() => (window as unknown as { submitted: unknown[] }).submitted.length === 1);
      const submitted = await page.evaluate(() => (window as unknown as { submitted: unknown[] }).submitted[0]);
      expect(submitted).toMatchObject({ sponsorshipRequiredNowOrFuture: false,
        applicationFacts: { authorization: { countries: ["United States"],
          sponsorshipRequiredNowOrFuture: false },
          education: [{ claim: "BS Computer Science, Example University", skills: ["Python"] }],
          projects: [{ name: 'Search project', claims: [{ claim: 'Built a search tool', skills: ['TypeScript', 'SQL'] }] }] } });
    } finally { await browser.close(); }
  });
});
