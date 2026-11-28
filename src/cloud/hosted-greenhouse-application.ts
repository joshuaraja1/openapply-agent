import { readFile, stat, unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Route } from "playwright";
import { z } from "zod";
import { AgentBrowser, type BrowserSnapshot } from "../browser/actions.js";
import { launchBrowser, type BrowserRuntime } from "../browser/runtime.js";
import { parseApprovedHostedProfile } from "../hosted/application-facts.js";
import { fillApplicationForm } from "../application/form-mapper.js";
import { hasUnboundReceiptUrl, isOriginalRequisition } from "../application/requisition.js";
import { createJakeResumeSource, type ResumeSource } from "../resume/jake.js";
import { readBundledJakeTemplate } from "../resume/bundled-template.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "../resume/verify-pdf.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import { boundJob, type HostedPreviewInput, type PreviewFetchedResponse } from "./hosted-pre-submit-preview.js";
import type { OfficialLeadRow } from "./official-lead-sync.js";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { CloudRunPorts, PreparedApplication, VerifiedReceipt } from "./queued-run.js";
import { HostedSubmissionBlocked } from "./hosted-submission-blocked.js";
export { HostedSubmissionBlocked } from "./hosted-submission-blocked.js";

const MAX_PROFILE_BYTES = 512_000;
const MAX_RECEIPT_TEXT = 8_000;
const greenhouseReceipt = z.strictObject({
  version: z.literal(1),
  job: z.strictObject({ provider: z.string(), employerId: z.string(), requisitionId: z.string() }),
  url: z.url(), confirmation: z.string().min(1).max(MAX_RECEIPT_TEXT),
});

export interface GreenhouseApplicationInput extends Omit<HostedPreviewInput, "profileBytes"> {
  /** Restored only through the candidate/run lease-scoped artifact broker. */
  profilePath: string;
}

export interface GreenhouseApplicationDependencies {
  renderResume(source: ResumeSource, job: DiscoveredJob, candidate: CandidateProfile,
    privateWorkDirectory: string): Promise<string>;
  launch?: typeof launchBrowser;
  verify?: typeof verifyResumePdf;
  fetchRequest?: (route: Route) => Promise<PreviewFetchedResponse>;
  now?: Date;
}

async function fetchWithoutRedirect(route: Route): Promise<PreviewFetchedResponse> {
  const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
  return { status: response.status(), headers: response.headers(), body: await response.body() };
}

function receiptLine(text: string, requisitionId: string): string | undefined {
  const escaped = requisitionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const id = new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, "i");
  return text.split(/\r?\n/).map(line => line.trim()).find(line =>
    /\b(application|applied)\b.{0,100}\b(received|submitted|successful|successfully)\b/i.test(line)
    && id.test(line));
}

function oneSubmit(snapshot: BrowserSnapshot): string | undefined {
  const controls = snapshot.controls.filter(control => control.type === "submit"
    || (control.tag === "button" && /^(submit|submit application|send application)$/i.test(control.name)));
  return controls.length === 1 ? controls[0]!.ref : undefined;
}

function blockerCode(value: string): string {
  if (value.startsWith("Required field needs an answer:")) return "unknown-required-field";
  if (value.startsWith("New required field appeared")) return "new-required-field";
  if (/verification|captcha/i.test(value)) return "human-verification";
  if (value === "Resume upload control was not found; verify this application step before submission") {
    return "resume-control-missing";
  }
  return /^[a-z-]{1,64}$/.test(value) ? value : "unsupported-form-field";
}

function sameJobUrl(raw: string, job: DiscoveredJob): boolean {
  try { return !hasUnboundReceiptUrl(job.id, job.applicationUrl, raw); }
  catch { return false; }
}

/**
 * Prepare one classic Greenhouse HTML form. Network writes stay blocked until
 * the queue handler has durably reserved submit intent and calls submitOnce.
 * Forms needing script/XHR submission, another host, or unknown answers stop.
 */
export async function prepareHostedGreenhouseApplication(input: GreenhouseApplicationInput,
  dependencies: GreenhouseApplicationDependencies): Promise<PreparedApplication> {
  if (!isAbsolute(input.privateWorkDirectory) || !isAbsolute(input.privateBrowserDirectory)
    || !isAbsolute(input.profilePath)) throw new Error("Cloud application requires private absolute paths");
  const file = await stat(input.profilePath);
  if (!file.isFile() || file.size < 1 || file.size > MAX_PROFILE_BYTES) {
    throw new Error("Approved profile artifact is unavailable");
  }
  const profileBytes = await readFile(input.profilePath);
  let runtime: BrowserRuntime | undefined;
  let resumePath: string | undefined;
  let returned = false;
  try {
    const job = boundJob(input.lead, input.runJob, dependencies.now ?? new Date());
    if (job.provider !== "greenhouse") throw new Error("Only Greenhouse is supported by this adapter");
    const candidate = parseApprovedHostedProfile(profileBytes, input.candidateId);
    const source = createJakeResumeSource(await readBundledJakeTemplate(), job, candidate);
    const rendered = resolve(await dependencies.renderResume(source, job, candidate,
      input.privateWorkDirectory));
    const workDirectory = resolve(input.privateWorkDirectory);
    if (rendered === workDirectory || !rendered.startsWith(`${workDirectory}${sep}`)) {
      throw new Error("Rendered résumé left the private work directory");
    }
    resumePath = rendered;
    const artifact: VerifiedResumeArtifact = await (dependencies.verify ?? verifyResumePdf)(
      rendered, job, candidate, source);
    if (resolve(artifact.path) !== rendered || artifact.jobId !== job.id
      || artifact.sourceFingerprint !== source.fingerprint
      || !/^[a-f0-9]{64}$/.test(artifact.pdfSha256)) {
      throw new Error("Verified résumé belongs to another application");
    }
    runtime = await (dependencies.launch ?? launchBrowser)({
      profileDirectory: input.privateBrowserDirectory, headless: true, serviceWorkers: "block",
    });
    const context = runtime.context;
    const host = new URL(job.applicationUrl).hostname.toLowerCase();
    let blockedWrites = 0;
    let blockedHosts = 0;
    let blockedSockets = 0;
    let allowFinalPost = false;
    let finalPostUrl: string | undefined;
    let finalPostCount = 0;
    await context.routeWebSocket("**/*", socket => {
      blockedSockets++;
      socket.close({ code: 1008, reason: "Application sockets are disabled" });
    });
    await context.route("**/*", async route => {
      const request = route.request();
      let target: URL;
      try { target = new URL(request.url()); }
      catch { blockedHosts++; await route.abort("blockedbyclient"); return; }
      if (target.protocol !== "https:" || target.hostname.toLowerCase() !== host
        || target.port || target.username || target.password) {
        blockedHosts++; await route.abort("blockedbyclient"); return;
      }
      const method = request.method().toUpperCase();
      if (!["GET", "HEAD"].includes(method)) {
        if (method !== "POST" || !allowFinalPost || target.href !== finalPostUrl
          || !request.isNavigationRequest() || finalPostCount !== 0) {
          blockedWrites++; await route.abort("blockedbyclient"); return;
        }
        finalPostCount++;
      }
      const response = await (dependencies.fetchRequest ?? fetchWithoutRedirect)(route);
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.location;
        if (!next || !sameJobUrl(new URL(next, target).href, job)) {
          blockedHosts++; await route.abort("blockedbyclient"); return;
        }
      }
      const headers = { ...response.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      await route.fulfill({ status: response.status, headers, body: response.body });
    });
    const browser = new AgentBrowser(context, new Set([host]),
      new Map([[rendered, artifact.pdfSha256]]));
    const initial = await browser.navigate(job.applicationUrl);
    if (!isOriginalRequisition(initial, job)) throw new Error("Employer form changed requisition");
    const filled = await fillApplicationForm(browser, initial, candidate, rendered,
      { provider: "greenhouse" });
    const blocked = async (codes: readonly string[], formUrl: string) => {
      const state = new TextEncoder().encode(JSON.stringify(await context.storageState()));
      if (state.byteLength > 512_000) throw new Error("Browser handoff state exceeds the private limit");
      return new HostedSubmissionBlocked({
        blockerCodes: [...new Set(codes.map(blockerCode))].slice(0, 20),
        formUrl, browserState: state, resumeSha256: artifact.pdfSha256, job: input.runJob,
      });
    };
    const blockers = [...filled.blockers];
    if (blockedWrites) blockers.push("early-network-write");
    if (blockedHosts) blockers.push("cross-host-or-redirect");
    if (blockedSockets) blockers.push("websocket");
    if (!filled.uploaded) blockers.push("resume-not-uploaded");
    const submitRef = oneSubmit(filled.snapshot);
    if (!submitRef) blockers.push("ambiguous-submit-control");
    if (blockers.length) throw await blocked(blockers, filled.snapshot.url);
    const finalClick = await browser.prepareFinalClick(submitRef!);
    const button = finalClick.page.locator('button[type="submit"], input[type="submit"]');
    if (await button.count() !== 1) throw await blocked(["ambiguous-submit-control"], filled.snapshot.url);
    const form = await button.first().evaluate(element => {
      const enclosing = (element as HTMLButtonElement | HTMLInputElement).form;
      return enclosing ? { method: enclosing.method.toLowerCase(), action: enclosing.action } : null;
    });
    if (!form || form.method !== "post" || !sameJobUrl(form.action, job)) {
      throw await blocked(["unsupported-submit-destination"], filled.snapshot.url);
    }
    finalPostUrl = form.action;
    let used = false;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await runtime!.close(); }
      finally { await unlink(rendered).catch(() => {}); }
    };
    returned = true;
    return {
      async submitOnce(beforeClick: () => Promise<boolean>): Promise<VerifiedReceipt | null> {
        if (used || closed) throw new Error("Final click is no longer available");
        used = true;
        if (receiptLine(await finalClick.page.locator("body").innerText(),
          input.runJob.requisitionId)) throw new Error("Employer receipt was visible before final click");
        if (finalClick.page.url() !== filled.snapshot.url
          || !sameJobUrl(finalClick.page.url(), job)
          || blockedWrites || blockedHosts || blockedSockets
          || await button.count() !== 1) {
          throw new Error("Employer form changed before final click");
        }
        if (!await beforeClick()) return null;
        // The queue handler has already written durable submit intent.
        allowFinalPost = true;
        await finalClick.click();
        try {
          await finalClick.page.waitForFunction((id: string) => {
            const text = document.body?.innerText ?? "";
            return text.length < 8_000 && text.split(/\r?\n/).some(line =>
              /\b(application|applied)\b.{0,100}\b(received|submitted|successful|successfully)\b/i.test(line)
              && line.includes(id));
          }, input.runJob.requisitionId, { timeout: 10_000 });
        } catch { throw new Error("Employer receipt did not identify the requisition"); }
        const text = await finalClick.page.locator("body").innerText();
        if (text.length > MAX_RECEIPT_TEXT || !sameJobUrl(finalClick.page.url(), job)
          || finalPostCount !== 1 || blockedHosts || blockedSockets) {
          throw new Error("Employer receipt is unavailable or unbound");
        }
        const confirmation = receiptLine(text, input.runJob.requisitionId);
        if (!confirmation) throw new Error("Employer receipt does not identify the requisition");
        return { job: input.runJob, evidence: new TextEncoder().encode(JSON.stringify({
          version: 1, job: input.runJob, url: finalClick.page.url(), confirmation,
        })) };
      }, close,
    };
  } finally {
    profileBytes.fill(0);
    if (!returned) {
      try { await runtime?.close(); }
      finally { if (resumePath) await unlink(resumePath).catch(() => {}); }
    }
  }
}

type ReceiptVerifier = CloudRunPorts["receiptVerifier"];

export class GreenhouseReceiptVerifier implements ReceiptVerifier {
  async verify(receipt: VerifiedReceipt, expected: OfficialJobIdentity): Promise<boolean> {
    if (receipt.evidence.byteLength < 1 || receipt.evidence.byteLength > MAX_RECEIPT_TEXT) return false;
    try {
      const row = greenhouseReceipt.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true })
        .decode(receipt.evidence)));
      const url = new URL(row.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      return expected.provider.toLowerCase() === "greenhouse"
        && officialJobKey(receipt.job) === officialJobKey(expected)
        && officialJobKey(row.job) === officialJobKey(expected)
        && ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname)
        && url.protocol === "https:" && !url.port && !url.username && !url.password
        && parts[0]?.toLowerCase() === expected.employerId.toLowerCase()
        && parts[1] === "jobs" && parts[2] === expected.requisitionId
        && !!receiptLine(row.confirmation, expected.requisitionId);
    } catch { return false; }
  }
}

export function assertGreenhouseLead(lead: OfficialLeadRow, job: OfficialJobIdentity): void {
  if (job.provider.toLowerCase() !== "greenhouse"
    || officialJobKey(lead.job) !== officialJobKey(job)) {
    throw new Error("Greenhouse lead is not bound to the cloud run");
  }
}
