import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../browser/runtime.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openapply-browser-smoke-"));
  try {
    const browser = await launchBrowser({
      profileDirectory: join(directory, "profile"),
      headless: true,
      serviceWorkers: "block",
    });
    try {
      const page = await browser.context.newPage();
      await page.goto("data:text/html,<title>OpenApply smoke</title><h1>Ready</h1>");
      if (await page.title() !== "OpenApply smoke"
        || await page.locator("h1").textContent() !== "Ready") {
        throw new Error("Cloud browser smoke did not render the local test page");
      }
      await page.close();
      process.stdout.write("Cloud browser smoke passed\n");
    } finally {
      await browser.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
