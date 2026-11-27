import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentBrowser, type BrowserSnapshot } from "../browser/actions.js";
import { launchBrowser } from "../browser/runtime.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import type { CloudRunPorts, PreparedApplication, VerifiedReceipt } from "./queued-run.js";

type ApplicationPort = CloudRunPorts["application"];
type ReceiptVerifierPort = CloudRunPorts["receiptVerifier"];

const FIXTURE_HOST = "fixture.openapply.invalid";
const fixtureJob = z.object({
  provider: z.literal("synthetic"), employerId: z.literal("fixture"),
  requisitionId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
});
const reviewedProfile = z.object({
  version: z.literal(1), provenance: z.literal("candidate-entered-and-reviewed"),
  candidateId: z.uuid(), workAuthorization: z.string().trim().min(1).max(300),
  sponsorshipRequiredNowOrFuture: z.boolean(),
  consent: z.object({ storage: z.literal(true), automation: z.literal(true), reviewed: z.literal(true) }),
});
const receiptSchema = z.strictObject({
  version: z.literal(1), job: fixtureJob,
  url: z.url(), confirmation: z.string(),
});

function fixtureUrl(job: z.infer<typeof fixtureJob>): string {
  return `https://${FIXTURE_HOST}/apply/${job.requisitionId}`;
}

function fixtureHtml(job: z.infer<typeof fixtureJob>): string {
  // The requisition ID is constrained to alphanumerics and hyphens above.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic ATS ${job.requisitionId}</title>
<h1>Synthetic application for requisition ${job.requisitionId}</h1>
<form id="application"><label for="authorization">Work authorization</label>
<input id="authorization" name="authorization" required>
<label for="sponsorship">Sponsorship required</label>
<select id="sponsorship" name="sponsorship" required><option value="">Choose</option>
<option value="yes">Yes</option><option value="no">No</option></select>
<button type="submit">Submit application</button></form><p id="confirmation" role="status"></p>
<script>document.getElementById('application').addEventListener('submit', event => {
  event.preventDefault(); document.getElementById('application').remove();
  document.getElementById('confirmation').textContent =
    'Application received for requisition ${job.requisitionId}';
});</script></html>`;
}

function only(snapshot: BrowserSnapshot, name: string): string {
  const matches = snapshot.controls.filter(control => control.name === name);
  if (matches.length !== 1) throw new Error(`Synthetic application control ${name} is unavailable`);
  return matches[0]!.ref;
}

/** The first cloud adapter is deliberately restricted to an intercepted .invalid
 * host. It proves browser ownership and submit-intent sequencing without
 * reaching an employer or exposing a candidate profile to a third party. */
export class SyntheticBrowserApplication implements ApplicationPort {
  constructor(private readonly audit?: {
    recordFinalClick(candidateId: string, runId: string, leaseToken: string,
      job: z.infer<typeof fixtureJob>): Promise<boolean>;
    afterFinalClick?(job: z.infer<typeof fixtureJob>): void;
  }) {}

  async prepare(profilePath: string, jobInput: OfficialJobIdentity,
    candidateId: string, context?: { runId: string; leaseToken: string }): Promise<PreparedApplication> {
    const job = fixtureJob.parse(jobInput);
    const file = await stat(profilePath);
    if (!file.isFile() || file.size > 64 * 1024) throw new Error("Reviewed profile is unavailable");
    const bytes = await readFile(profilePath);
    let profile: z.infer<typeof reviewedProfile>;
    try { profile = reviewedProfile.parse(JSON.parse(bytes.toString("utf8"))); }
    finally { bytes.fill(0); }
    if (profile.candidateId !== candidateId) throw new Error("Reviewed profile belongs to another candidate");

    const root = await mkdtemp(join(tmpdir(), "openapply-synthetic-"));
    let runtime: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      runtime = await launchBrowser({ profileDirectory: join(root, "profile"),
        headless: true, serviceWorkers: "block" });
      const expectedUrl = fixtureUrl(job);
      await runtime.context.route("**/*", async route => {
        if (route.request().url() !== expectedUrl) { await route.abort(); return; }
        await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8",
          body: fixtureHtml(job) });
      });
      const browser = new AgentBrowser(runtime.context, new Set([FIXTURE_HOST]));
      let snapshot = await browser.navigate(expectedUrl);
      snapshot = await browser.act(only(snapshot, "Work authorization"), "fill", profile.workAuthorization);
      snapshot = await browser.act(only(snapshot, "Sponsorship required"), "select",
        profile.sponsorshipRequiredNowOrFuture ? "Yes" : "No");
      const finalClick = await browser.prepareFinalClick(only(snapshot, "Submit application"));
      const thisAudit = this.audit;
      let used = false;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try { await runtime!.close(); }
        finally { await rm(root, { recursive: true, force: true }); }
      };
      return {
        async submitOnce(): Promise<VerifiedReceipt> {
          if (used || closed) throw new Error("Synthetic final click is no longer available");
          used = true;
          if (await finalClick.page.locator("#confirmation").innerText()) {
            throw new Error("Synthetic receipt appeared before final click");
          }
          if (process.env.OPENAPPLY_CLOUD_TASK_MODE === "synthetic" && !thisAudit) {
            throw new Error("Cloud synthetic final click requires a durable audit");
          }
          if (thisAudit) {
            if (!context || !await thisAudit.recordFinalClick(candidateId, context.runId,
              context.leaseToken, job)) {
              throw new Error("Synthetic final click audit denied");
            }
          }
          await finalClick.click();
          thisAudit?.afterFinalClick?.(job);
          const confirmation = finalClick.page.locator("#confirmation");
          await finalClick.page.getByText(`Application received for requisition ${job.requisitionId}`,
            { exact: true }).waitFor({ timeout: 10_000 });
          const evidence = new TextEncoder().encode(JSON.stringify({ version: 1, job,
            url: finalClick.page.url(), confirmation: await confirmation.innerText() }));
          return { evidence, job };
        }, close,
      };
    } catch (error) {
      try { await runtime?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
      throw error;
    }
  }
}

export class SyntheticReceiptVerifier implements ReceiptVerifierPort {
  async verify(receipt: VerifiedReceipt, expected: OfficialJobIdentity): Promise<boolean> {
    if (receipt.evidence.byteLength === 0 || receipt.evidence.byteLength > 8192) return false;
    try {
      const evidence = receiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(receipt.evidence)));
      return officialJobKey(receipt.job) === officialJobKey(expected)
        && officialJobKey(evidence.job) === officialJobKey(expected)
        && evidence.url === fixtureUrl(fixtureJob.parse(expected))
        && evidence.confirmation === `Application received for requisition ${expected.requisitionId}`;
    } catch { return false; }
  }
}
