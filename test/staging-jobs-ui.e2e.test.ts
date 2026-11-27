import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.OPENAPPLY_BROWSER_E2E !== "1")("staging job seeker matches", () => {
  it("requests with the signed-in token and renders the official link as safe text", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const html = (await readFile("cloud/staging-login/index.html", "utf8"))
        .replace('<script type="module" src="/login.js"></script>', "");
      const source = await readFile("cloud/staging-login/jobs.js", "utf8");
      await page.setContent(html);
      await page.evaluate(() => {
        (window as unknown as { calls: unknown[] }).calls = [];
        window.fetch = async (url, init) => {
          (window as unknown as { calls: unknown[] }).calls.push({ url, headers: init?.headers });
          return new Response(JSON.stringify({ jobs: [{
            title: '<img src=x onerror="window.xss=1"> Software Engineer',
            company: "Example Co", location: "Remote", provider: "greenhouse",
            officialUrl: "https://job-boards.greenhouse.io/example/jobs/123",
          }], nextPage: null }), { status: 200 });
        };
      });
      await page.addScriptTag({ type: "module", content:
        `${source}\nattachJobMatches({ getIdToken: () => "signed.in.token" });` });
      await page.locator(".job-card").waitFor();
      expect(await page.locator(".job-card h3").textContent()).toContain("<img src=x");
      expect(await page.locator(".job-card img").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { xss?: number }).xss)).toBeUndefined();
      const link = page.getByRole("link", { name: "Open official job posting" });
      expect(await link.getAttribute("href")).toBe("https://job-boards.greenhouse.io/example/jobs/123");
      expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)).toEqual([{
        url: "/api/jobs/matches?page=0", headers: { Authorization: "Bearer signed.in.token" },
      }]);
    } finally { await browser.close(); }
  });
});
