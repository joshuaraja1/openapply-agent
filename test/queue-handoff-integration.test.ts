import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { notifyPendingHandoff, sendHandoffEmail, handoffNotificationSchema } from "../src/application/notification.js";
import { runApplicationQueue } from "../src/application/queue-runner.js";
import { applicationPackageSchema, runApplicationPackage } from "../src/application/runner.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { DailyQuota } from "../src/application/daily-quota.js";
import { RetryLedger } from "../src/application/retry-ledger.js";
import { candidateProfileSchema } from "../src/candidate/schema.js";
import type { BrowserControl } from "../src/browser/actions.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import type { DiscoveredJob } from "../src/types.js";

const job: DiscoveredJob = {
  id: "greenhouse:example:123456", provider: "greenhouse", company: "Example Co",
  title: "Software Engineer", descriptionText: "Build software with Python.",
  applicationUrl: "https://jobs.example.com/apply/123456",
  sourceUrl: "https://jobs.example.com/jobs/123456", location: "Remote", department: null,
  employmentType: null, workplaceType: null, compensation: null, sourcePublishedAt: null,
  sourceUpdatedAt: null, firstSeenAt: "2026-11-25T00:00:00Z", discoveredAt: "2026-11-25T00:00:00Z",
  isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [],
};
const candidate = candidateProfileSchema.parse({ version: 1,
  identity: { fullName: "Test Candidate", location: "Dallas, TX",
    email: "candidate@example.net", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
  skills: {}, education: [], experience: [], projects: [],
});
const pkg = applicationPackageSchema.parse({ version: 1, browserRuntime: "owned", job, candidate,
  source: { provider: "greenhouse", boardToken: "example", company: "Example Co",
    enabled: true, allowedApplicationHosts: ["jobs.example.com"] },
  handoff: createApplicationHandoff(job, false),
  resumeSource: { latex: "synthetic fixture", fingerprint: "f".repeat(64),
    renderToken: "a".repeat(64), claimIds: ["fixture"] },
  resumePdfPath: "/tmp/synthetic-resume.pdf", expectedConfirmation: "Application 123456 received",
});
const config = handoffNotificationSchema.parse({ version: 1, email: {
  provider: "resend", from: "alerts@example.org", to: "candidate@example.net",
  apiKeySecretRef: "keychain://openapply/test-resend",
} });
const resume: BrowserControl = { ref: "resume", tag: "input", role: "button", name: "Resume", type: "file",
  value: null, required: true, options: [] };
const next: BrowserControl = { ref: "next", tag: "button", role: "button", name: "Continue", type: "button",
  value: null, required: false, options: [] };
const answer: BrowserControl = { ref: "answer", tag: "input", role: "textbox", name: "Project preference", type: "text",
  value: "", required: true, options: [] };
const submit: BrowserControl = { ref: "submit", tag: "button", role: "button", name: "Submit application",
  type: "submit", value: null, required: false, options: [] };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("controlled queue to handoff staging flow", () => {
  it("sends one generic alert for an unknown field, replays safely, then submits only after an approved answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-staging-handoff-"));
    directories.push(directory);
    if (process.platform === "win32") await secureWindowsPrivatePath(directory);
    const statePath = join(directory, "applications.enc.json");
    const key = Buffer.alloc(32, 7);
    const applicationStore = new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, key);
    const workflow = new ApplicationWorkflow(applicationStore);
    const quota = new DailyQuota(new MemoryApplicationStateStore());
    const retries = new RetryLedger(new MemoryApplicationStateStore());
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"id":"email_1"}', { status: 200 }));
    const secrets = { get: vi.fn(async () => "synthetic-api-key"),
      put: async () => {}, delete: async () => {} };
    const send = async (checkpoint: ApplicationCheckpoint,
      activeWorkflow: ApplicationWorkflow = workflow) =>
      notifyPendingHandoff(activeWorkflow, checkpoint, secrets, config, {
        desktopEnabled: false,
        email: (emailConfig, saved, store) => sendHandoffEmail(emailConfig, saved, store,
          fetcher as typeof fetch),
      });
    const submitClick = vi.fn(async () => "Application 123456 received");
    let approved = false;
    const firstPage = { url: job.applicationUrl, title: "Documents",
      visibleText: "Example Co Software Engineer application", controls: [resume, next] };
    const secondPage = () => ({ url: `${job.applicationUrl}/step-2`, title: "Questions",
      visibleText: "Example Co Software Engineer application",
      controls: [{ ...answer, value: approved ? "Platform" : "" }, submit] });
    let currentUrl = job.applicationUrl;
    const browser = { currentUrl: () => currentUrl,
      navigate: async () => { currentUrl = job.applicationUrl; return firstPage; },
      act: async (ref: string) => {
        if (ref === "next") { currentUrl = `${job.applicationUrl}/step-2`; return secondPage(); }
        return firstPage;
      },
      fillBatch: async (actions: Array<{ name: string; value: string }>) => {
        if (actions.some((action) => action.name === "Project preference")) approved = true;
        return currentUrl.endsWith("step-2") ? secondPage() : firstPage;
      }, submit: submitClick };
    const run = async (resumeApproved = false) => runApplicationPackage(pkg, workflow, "/tmp/profile", {
      verify: async () => ({ jobId: job.id, sourceFingerprint: pkg.resumeSource.fingerprint,
        pdfSha256: "a".repeat(64), path: pkg.resumePdfPath, pages: 1,
        verifiedAt: "2026-11-25T00:00:00Z" }),
      validateOfficial: async () => true,
      browserFactory: async () => ({ browser, close: async () => {} }),
      ...(resumeApproved ? { resumedJobId: job.id,
        humanAnswerApproval: { jobId: job.id, browserPageId: 0, approveFinalSubmission: true,
          answers: new Map([["Project preference", "Platform"]]) } } : {}),
    });
    const first = await runApplicationQueue([job], quota, retries, () => "2026-11-25", 1,
      async () => {
        const result = await run();
        if (result.checkpoint.stage === "waiting-human") await send(result.checkpoint);
        return result.checkpoint.stage === "waiting-human" ? "waiting-human" : undefined;
      });
    expect(first).toEqual([{ jobId: job.id, status: "waiting-human" }]);
    expect((await workflow.current(job.id))?.resumeUploaded).toBe(true);
    expect(submitClick).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, request] = fetcher.mock.calls[0]!;
    expect(endpoint).toBe("https://api.resend.com/emails");
    const body = String(request?.body);
    expect(body).toContain("An application is paused");
    expect(body).not.toContain(job.id);
    expect(body).not.toContain(job.applicationUrl);
    expect(body).not.toContain("Project preference");
    const restartedWorkflow = new ApplicationWorkflow(
      new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, key));
    await send((await restartedWorkflow.current(job.id))!, restartedWorkflow);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await readFile(statePath, "utf8")).not.toContain(job.applicationUrl);
    expect(await runApplicationQueue([job], quota, retries, () => "2026-11-25", 1,
      async () => { throw new Error("quota should prevent rerun"); }))
      .toEqual([{ jobId: job.id, status: "duplicate" }]);
    const resumed = await run(true);
    expect(resumed.checkpoint.stage).toBe("submitted");
    expect(resumed.checkpoint.confirmation).toBe("Application 123456 received");
    expect(submitClick).toHaveBeenCalledOnce();
    await expect(run()).rejects.toThrow("Application is submitted");
  });
});
