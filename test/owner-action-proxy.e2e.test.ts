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
import { OwnerSubmitJournal, receiptPolicySha256 } from "../src/browser/owner-submit-journal.js";

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

async function submitWorker(input: { socketPath: string; secret: Buffer; request: object;
  crashAfterResponse?: boolean }) {
  const source = `import { requestOwnedSubmit } from ${JSON.stringify(pathToFileURL(resolve("src/browser/owner-service.ts")).href)};
const input = JSON.parse(process.env.OWNER_TEST_INPUT);
try { const result = await requestOwnedSubmit({ socketPath: input.socketPath,
 secret: Buffer.from(input.secret, "hex"), request: input.request });
 if (input.crashAfterResponse) process.kill(process.pid, "SIGKILL");
 process.stdout.write(JSON.stringify(result)); } catch { process.exitCode = 2; }`;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: resolve("."), env: { ...process.env, OWNER_TEST_INPUT: JSON.stringify({
      socketPath: input.socketPath, secret: input.secret.toString("hex"),
      request: input.request, crashAfterResponse: input.crashAfterResponse ?? false }) },
    timeout: 20_000,
  });
  return JSON.parse(stdout) as { tabId: string; generation: string;
    outcome: "receipt" | "uncertain"; receiptUrl?: string };
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
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") postReached += 1;
        if (new URL(route.request().url()).pathname === "/sw.js") {
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
      await owner.registerBrowser(binding, runtime);
      const request = (action: "navigate-tab" | "snapshot-tab", extra = {}) => ({
        version: 1, action, requestId: randomUUID(), generation, ...binding, ...extra,
      });
      try {
        const first = await worker({ socketPath, secret, request: request("navigate-tab", { url: officialUrl }) });
        const page = runtime.context.pages().at(-1)!;
        await page.waitForFunction(() => (window as Window & { postBlocked?: boolean }).postBlocked === true);
        await page.waitForFunction(() => (window as Window & { swAttempted?: boolean }).swAttempted === true);
        await page.waitForFunction(() => (window as Window & { wsClosed?: boolean }).wsClosed === true);
        expect(postReached).toBe(0);
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
    it("persists one final-click claim, blocks preclaim JS POST, and reconciles after worker death", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-submit-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const binding = { tabId: randomUUID(), claimId: randomUUID(),
        jobId: "example:123456", officialUrl: "https://jobs.example.test/123456",
        packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let posted = 0;
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") {
          posted += 1;
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Receipt</title>
            <div role="status"><div>Application received</div><div>Example Inc — Software Engineer</div><div>123456</div></div>` });
        }
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Example job</title>
          <form action="/123456/submit" method="post">
            <label>First name <input name="first_name" aria-label="First name" oninput="fetch('/123456/submit',{method:'POST'}).catch(()=>window.blocked=true)"></label>
            <button type="submit" onclick="sessionStorage.clicks=String(Number(sessionStorage.clicks||0)+1);fetch('/123456/submit',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'first_name=Candidate'}).catch(()=>{})">Submit application</button>
          </form>` });
      });
      const owner = await startOwnerInspectionService({ socketPath, secret, generation,
        journalDirectory: root });
      await expect(owner.registerBrowser(binding, runtime, { company: "Example Inc",
        role: "Software Engineer", phrase: "Application received",
        postUrl: "https://jobs.example.test/other-job/submit", postFields: { first_name: "Candidate" } }))
        .rejects.toThrow("exact receipt binding");
      await owner.registerBrowser(binding, runtime, { company: "Example Inc", role: "Software Engineer",
        phrase: "Application received", postUrl: "https://jobs.example.test/123456/submit",
        postFields: { first_name: "Candidate" } });
      const request = (action: string, extra = {}) => ({ version: 1, action,
        requestId: randomUUID(), generation, ...binding, ...extra });
      try {
        const first = await worker({ socketPath, secret,
          request: request("navigate-tab", { url: binding.officialUrl }) });
        const page = runtime.context.pages().at(-1)!;
        await page.locator("input").fill("Candidate");
        await page.waitForFunction(() => (window as Window & { blocked?: boolean }).blocked === true);
        expect(posted).toBe(0);
        const ref = first.snapshot.controls.find((control) => control.name === "Submit application")!.ref;
        await expect(submitWorker({ socketPath, secret,
          request: request("submit-once", { ref }), crashAfterResponse: true })).rejects.toThrow();
        expect({ url: page.url(), posted, status: await page.locator('[role="status"]').allInnerTexts() })
          .toMatchObject({ url: "https://jobs.example.test/123456/submit", posted: 1 });
        const receipt = await submitWorker({ socketPath, secret, request: request("reconcile-submit") });
        expect(receipt).toMatchObject({ tabId: binding.tabId, generation,
          outcome: "receipt", receiptUrl: "https://jobs.example.test/123456/submit" });
        expect(posted).toBe(1);
        expect(await page.evaluate(() => sessionStorage.getItem("clicks"))).toBe("1");
        expect(runtime.context.pages().at(-1)).toBe(page);
        const repeated = await submitWorker({ socketPath, secret, request: request("submit-once", { ref }) });
        expect(repeated.outcome).toBe("receipt");
        expect(posted).toBe(1);
        expect(await page.evaluate(() => sessionStorage.getItem("clicks"))).toBe("1");
        await page.locator('[role="status"] div').nth(1).evaluate((element) => {
          element.textContent = "Other Inc — Other Role";
        });
        const unrelated = await runtime.context.newPage();
        await unrelated.goto("https://jobs.example.test/123456/submit");
        await unrelated.setContent('<div role="status"><div>Application received</div><div>Example Inc — Software Engineer</div><div>123456</div></div>');
        expect((await submitWorker({ socketPath, secret,
          request: request("reconcile-submit") })).outcome).toBe("uncertain");
        expect(posted).toBe(1);
        expect(await new OwnerSubmitJournal(root).read(binding.claimId)).toMatchObject({ binding });
      } finally { await owner.close(); await runtime.close(); await rm(root, { recursive: true }); }
    }, 60_000);
    it("does not click when a prior owner died after journaling but before dispatch", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-before-click-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const binding = { tabId: randomUUID(), claimId: randomUUID(),
        jobId: "example:123456", officialUrl: "https://jobs.example.test/123456",
        packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let posts = 0;
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") posts += 1;
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Job</title>
          <form action="/123456/submit" method="post"><input type="hidden" name="candidate" value="Fixture"><button type="submit"
          onclick="sessionStorage.clicks=String(Number(sessionStorage.clicks||0)+1)">Submit application</button></form>` });
      });
      const owner = await startOwnerInspectionService({ socketPath, secret, generation,
        journalDirectory: root });
      await owner.registerBrowser(binding, runtime, { company: "Example Inc", role: "Software Engineer",
        phrase: "Application received", postUrl: "https://jobs.example.test/123456/submit",
        postFields: { candidate: "Fixture" } });
      const request = (action: string, extra = {}) => ({ version: 1, action,
        requestId: randomUUID(), generation, ...binding, ...extra });
      try {
        const first = await worker({ socketPath, secret,
          request: request("navigate-tab", { url: binding.officialUrl }) });
        const page = runtime.context.pages().at(-1)!;
        const ref = first.snapshot.controls.find((control) => control.name === "Submit application")!.ref;
        // This is the durable state left by a fault between fsync and click.
        await new OwnerSubmitJournal(root).claim(binding, binding.officialUrl,
          receiptPolicySha256({ company: "Example Inc", role: "Software Engineer",
            phrase: "Application received", postUrl: "https://jobs.example.test/123456/submit",
            postFields: { candidate: "Fixture" } }));
        const result = await submitWorker({ socketPath, secret, request: request("submit-once", { ref }) });
        expect(result.outcome).toBe("uncertain");
        expect(posts).toBe(0);
        expect(await page.evaluate(() => sessionStorage.getItem("clicks"))).toBeNull();
        expect((await submitWorker({ socketPath, secret,
          request: request("reconcile-submit") })).outcome).toBe("uncertain");
      } finally { await owner.close(); await runtime.close(); await rm(root, { recursive: true }); }
    }, 60_000);
    it("rejects a restarted owner that changes the saved receipt policy", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-policy-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const binding = { tabId: randomUUID(), claimId: randomUUID(),
        jobId: "example:123456", officialUrl: "https://jobs.example.test/123456",
        packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let posts = 0;
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") posts += 1;
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Job</title>
          <form action="/123456/submit" method="post"><input type="hidden" name="candidate" value="Fixture">
          <button type="submit" onclick="sessionStorage.clicks='1'">Submit application</button></form>` });
      });
      const owner = await startOwnerInspectionService({ socketPath, secret, generation,
        journalDirectory: root });
      const originalPolicy = { company: "Example Inc", role: "Software Engineer",
        phrase: "Application received", postUrl: "https://jobs.example.test/123456/submit",
        postFields: { candidate: "Fixture" } };
      await owner.registerBrowser(binding, runtime, { ...originalPolicy, role: "Different Role" });
      const request = (action: string, extra = {}) => ({ version: 1, action,
        requestId: randomUUID(), generation, ...binding, ...extra });
      try {
        const first = await worker({ socketPath, secret,
          request: request("navigate-tab", { url: binding.officialUrl }) });
        const ref = first.snapshot.controls.find((control) => control.name === "Submit application")!.ref;
        await new OwnerSubmitJournal(root).claim(binding, binding.officialUrl,
          receiptPolicySha256(originalPolicy));
        await expect(submitWorker({ socketPath, secret,
          request: request("submit-once", { ref }) })).rejects.toThrow();
        expect(posts).toBe(0);
        expect(await runtime.context.pages().at(-1)!.evaluate(() => sessionStorage.getItem("clicks")))
          .toBeNull();
      } finally { await owner.close(); await runtime.close(); await rm(root, { recursive: true }); }
    }, 60_000);
    it("does not accept a forged DOM receipt absent from the accepted POST response", async () => {
      const root = await mkdtemp(join(tmpdir(), "openapply-owner-fake-receipt-"));
      const runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const socketPath = join(root, "owner.sock");
      const secret = randomBytes(32);
      const generation = randomUUID();
      const binding = { tabId: randomUUID(), claimId: randomUUID(),
        jobId: "example:123456", officialUrl: "https://jobs.example.test/123456",
        packageSha256: "a".repeat(64), artifactSha256: "b".repeat(64) };
      let posts = 0;
      await runtime.context.route("https://jobs.example.test/**", (route) => {
        if (route.request().method() === "POST") {
          posts += 1;
          return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Pending</title><p>Processing</p>" });
        }
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Job</title>
          <form action="/123456/submit" method="post"><input type="hidden" name="candidate" value="Fixture">
          <button type="submit">Submit application</button></form>` });
      });
      const owner = await startOwnerInspectionService({ socketPath, secret, generation,
        journalDirectory: root });
      await owner.registerBrowser(binding, runtime, { company: "Example Inc", role: "Software Engineer",
        phrase: "Application received", postUrl: "https://jobs.example.test/123456/submit",
        postFields: { candidate: "Fixture" } });
      const request = (action: string, extra = {}) => ({ version: 1, action,
        requestId: randomUUID(), generation, ...binding, ...extra });
      try {
        const first = await worker({ socketPath, secret,
          request: request("navigate-tab", { url: binding.officialUrl }) });
        const ref = first.snapshot.controls.find((control) => control.name === "Submit application")!.ref;
        expect((await submitWorker({ socketPath, secret,
          request: request("submit-once", { ref }) })).outcome).toBe("uncertain");
        expect(posts).toBe(1);
        const page = runtime.context.pages().at(-1)!;
        await page.locator("body").evaluate((body) => {
          body.innerHTML = '<div role="status"><div>Application received</div><div>Example Inc — Software Engineer</div><div>123456</div></div>';
        });
        expect((await submitWorker({ socketPath, secret,
          request: request("reconcile-submit") })).outcome).toBe("uncertain");
      } finally { await owner.close(); await runtime.close(); await rm(root, { recursive: true }); }
    }, 60_000);
  },
);
