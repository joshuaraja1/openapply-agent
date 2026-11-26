import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser/runtime.js";
import { startOwnerInspectionService } from "../src/browser/owner-service.js";

const execFileAsync = promisify(execFile);
const officialUrl = "https://jobs.example.test/123";

async function worker(input: { socketPath: string; secret: Buffer; request: object;
  crashAfterResponse?: boolean }) {
  const source = `import { requestOwnedBrowser } from ${JSON.stringify(pathToFileURL(resolve("src/browser/owner-service.ts")).href)};
const input = JSON.parse(process.env.OWNER_TEST_INPUT);
try { const result = await requestOwnedBrowser({ socketPath: input.socketPath,
 secret: Buffer.from(input.secret, "hex"), request: input.request });
 if (input.crashAfterResponse) process.kill(process.pid, "SIGKILL");
 process.stdout.write(JSON.stringify(result)); } catch { process.exitCode = 2; }`;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: resolve("."), env: { ...process.env, OWNER_TEST_INPUT: JSON.stringify({
      socketPath: input.socketPath, secret: input.secret.toString("hex"),
      request: input.request, crashAfterResponse: input.crashAfterResponse ?? false }) },
    timeout: 20_000,
  });
  return JSON.parse(stdout) as { tabId: string; generation: string; snapshot: {
    url: string; visibleText: string; controls: { ref: string; name: string; type: string | null }[] } };
}

describe.skipIf(process.platform === "win32" || process.env.OPENAPPLY_BROWSER_E2E !== "1")(
  "owner-held Chromium inspection proxy", () => {
    it("keeps one read-only tab across worker restarts and rejects all form actions", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-action-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const tabId = randomUUID();
      const binding = { tabId, claimId: randomUUID(), jobId: "example:123", officialUrl,
        packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let postReached = 0;
      let getSubmitReached = 0;
      let reviewedReadReached = 0;
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") postReached += 1;
        const path = new URL(route.request().url()).pathname;
        if (path === "/submit") getSubmitReached += 1;
        if (path === "/safe-read") reviewedReadReached += 1;
        if (path === "/sw.js") {
          return route.fulfill({ contentType: "text/javascript", body: "self.addEventListener('fetch', () => {})" });
        }
        return route.fulfill({
        contentType: "text/html", body: `<!doctype html><title>Example job</title>
          <main><h1>Example job</h1><label>First name <input aria-label="First name"
          oninput="window.finalClicks=(window.finalClicks||0)+1"></label>
          <input aria-label="Resume" type="file" onchange="window.finalClicks=(window.finalClicks||0)+1">
          <button type="submit" onclick="window.finalClicks=(window.finalClicks||0)+1">Submit application</button>
          <p id="step">Step one</p></main>
          <script>fetch('/submit', {method:'POST'}).catch(() => {window.postBlocked=true});
            fetch('/submit?candidate=Fixture').catch(() => {window.getSubmitBlocked=true});
            fetch('/safe-read').then(() => {window.safeRead=true});
            navigator.serviceWorker.register('/sw.js').finally(() => {window.swAttempted=true});
            const ws = new WebSocket('wss://jobs.example.test/socket');
            ws.onclose = () => {window.wsClosed=true}</script>`,
        });
      });
      const owner = await startOwnerInspectionService({ socketPath, secret, generation });
      const unguarded = await launchBrowser({ profileDirectory: join(root, "unguarded"), headless: true });
      try {
        await expect(owner.registerBrowser(binding, unguarded)).rejects.toThrow("block service workers");
      } finally {
        await unguarded.close();
      }
      await owner.registerBrowser(binding, runtime, ["https://jobs.example.test/safe-read"]);
      const request = (action: "navigate-tab" | "snapshot-tab", extra = {}) => ({
        version: 1, action, requestId: randomUUID(), generation, ...binding, ...extra,
      });
      try {
        const first = await worker({ socketPath, secret, request: request("navigate-tab", { url: officialUrl }) });
        const page = runtime.context.pages().at(-1)!;
        await page.waitForFunction(() => (window as Window & { postBlocked?: boolean }).postBlocked === true);
        await page.waitForFunction(() => (window as Window & { getSubmitBlocked?: boolean }).getSubmitBlocked === true);
        await page.waitForFunction(() => (window as Window & { safeRead?: boolean }).safeRead === true);
        await page.waitForFunction(() => (window as Window & { swAttempted?: boolean }).swAttempted === true);
        await page.waitForFunction(() => (window as Window & { wsClosed?: boolean }).wsClosed === true);
        expect(postReached).toBe(0);
        expect(getSubmitReached).toBe(0);
        expect(reviewedReadReached).toBe(1);
        expect(runtime.context.serviceWorkers()).toHaveLength(0);
        expect(first.tabId).toBe(tabId);
        expect(first.generation).toBe(generation);
        await expect(worker({ socketPath, secret,
          request: request("navigate-tab", { url: officialUrl }) })).rejects.toThrow();
        await expect(worker({ socketPath, secret,
          request: { ...request("snapshot-tab"), claimId: randomUUID() } })).rejects.toThrow();
        // Simulate state that remains in the owner-held tab; the worker has no write operation.
        await page.locator('input[aria-label="First name"]').evaluate((field: HTMLInputElement) => {
          field.value = "Test Candidate";
        });
        await expect(worker({ socketPath, secret, request: request("snapshot-tab"),
          crashAfterResponse: true })).rejects.toThrow();
        const recovered = await worker({ socketPath, secret, request: request("snapshot-tab") });
        expect(recovered.tabId).toBe(tabId);
        expect(recovered.generation).toBe(generation);
        expect(recovered.snapshot.controls.find((control) => control.name === "First name"))
          .toHaveProperty("value", "Test Candidate");
        expect(recovered.snapshot.visibleText).toContain("Step one");
        expect(runtime.context.pages().at(-1)).toBe(page);
        const name = recovered.snapshot.controls.find((control) => control.name === "First name")!;
        const upload = recovered.snapshot.controls.find((control) => control.name === "Resume")!;
        const submit = recovered.snapshot.controls.find((control) => control.name === "Submit application")!;
        await expect(worker({ socketPath, secret,
          request: { ...request("snapshot-tab"), action: "act-tab", kind: "fill",
            ref: name.ref, value: "Changed" } })).rejects.toThrow();
        await expect(worker({ socketPath, secret,
          request: { ...request("snapshot-tab"), action: "act-tab", kind: "upload",
            ref: upload.ref, value: "/tmp/file.pdf" } })).rejects.toThrow();
        await expect(worker({ socketPath, secret,
          request: { ...request("snapshot-tab"), action: "act-tab", kind: "click", ref: submit.ref } }))
          .rejects.toThrow();
        await expect(worker({ socketPath, secret,
          request: { ...request("snapshot-tab"), action: "submit-tab", ref: submit.ref } })).rejects.toThrow();
        expect(await page.evaluate(() => (window as Window & { finalClicks?: number }).finalClicks ?? 0)).toBe(0);
      } finally {
        await owner.close();
        await runtime.close();
        await rm(root, { recursive: true });
      }
    }, 60_000);
    it("rejects a restored page with a preexisting socket before binding a claim", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-restored-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const binding = { tabId: randomUUID(), claimId: randomUUID(), jobId: "example:123",
        officialUrl, packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let socketOpened = false;
      await runtime.context.route("https://jobs.example.test/**", (route) => route.fulfill({
        contentType: "text/html", body: "<title>Restored job</title><h1>Restored job</h1>",
      }));
      await runtime.context.routeWebSocket("wss://jobs.example.test/socket", () => {
        socketOpened = true;
      });
      const preexistingPage = await runtime.context.newPage();
      await preexistingPage.goto(officialUrl);
      await preexistingPage.evaluate(() => { new WebSocket("wss://jobs.example.test/socket"); });
      await expect.poll(() => socketOpened).toBe(true);
      const owner = await startOwnerInspectionService({ socketPath, secret, generation });
      try {
        await expect(owner.registerBrowser(binding, runtime)).rejects.toThrow("preexisting page");
        expect(preexistingPage.isClosed()).toBe(true);
        await expect(worker({ socketPath, secret, request: { version: 1, action: "navigate-tab",
          requestId: randomUUID(), generation, ...binding, url: officialUrl } })).rejects.toThrow();
      } finally {
        await owner.close();
        await runtime.close();
        await rm(root, { recursive: true });
      }
    }, 60_000);
  },
);
