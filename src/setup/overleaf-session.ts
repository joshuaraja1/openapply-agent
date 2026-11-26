import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchBrowser } from "../browser/runtime.js";
import { assertOverleafProjectUrl } from "../resume/overleaf.js";

/** Explicit read-only setup check against the user's dedicated owned profile. */
export async function probeOwnedOverleafSession(projectUrl: string,
  launch: typeof launchBrowser = launchBrowser): Promise<boolean> {
  assertOverleafProjectUrl(projectUrl);
  const approvedDocument = new URL(projectUrl).href;
  const runtime = await launch({
    profileDirectory: join(userInfo().homedir, ".openapply-agent", "browser-profile"),
    headless: false,
    launch: (profile, options) => chromium.launchPersistentContext(profile,
      { ...options, serviceWorkers: "block" }),
  });
  try {
    await runtime.context.route("**/*", async (route) => {
      const request = route.request();
      let target: URL;
      try { target = new URL(request.url()); }
      catch { await route.abort("blockedbyclient"); return; }
      // This check intentionally has no generic same-origin GET exception: a
      // page script can encode a state-changing operation in a GET URL.
      if (target.href !== approvedDocument || request.method() !== "GET") {
        await route.abort("blockedbyclient"); return;
      }
      await route.fallback();
    });
    await runtime.context.routeWebSocket("**/*", (route) => route.close({ code: 1008 }));
    if (runtime.context.serviceWorkers().length) throw new Error("Service workers are active");
    const restored = runtime.context.pages();
    const hasRestoredPage = restored.some((page) => page.url() !== "about:blank");
    await Promise.all(restored.map((page) => page.close()));
    if (hasRestoredPage) {
      throw new Error("Existing browser pages require manual inspection");
    }
    const page = await runtime.context.newPage();
    try {
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const current = new URL(page.url());
      if (current.origin !== "https://www.overleaf.com"
        || current.pathname !== new URL(projectUrl).pathname) return false;
      const editor = page.getByRole("textbox", { name: "Source Editor editing", exact: true });
      try { await editor.waitFor({ state: "visible", timeout: 10_000 }); }
      catch { return false; }
      return await editor.count() === 1;
    } finally { await page.close(); }
  } finally { await runtime.close(); }
}
