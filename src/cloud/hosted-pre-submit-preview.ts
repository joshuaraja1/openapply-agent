import { unlink } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Route } from "playwright";
import { AgentBrowser, type BrowserSnapshot } from "../browser/actions.js";
import { launchBrowser, type BrowserRuntime } from "../browser/runtime.js";
import { officialSourceForLead } from "../browser/verify-official.js";
import { parseApprovedHostedProfile } from "../hosted/application-facts.js";
import { fillApplicationForm } from "../application/form-mapper.js";
import { isOriginalRequisition } from "../application/requisition.js";
import { createJakeResumeSource, type ResumeSource } from "../resume/jake.js";
import { readBundledJakeTemplate } from "../resume/bundled-template.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "../resume/verify-pdf.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import type { OfficialLeadRow } from "./official-lead-sync.js";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";

export interface HostedPreviewInput {
  candidateId: string;
  /** Bound to the trusted run record, never taken from a browser message. */
  runJob: OfficialJobIdentity;
  /** Refetched and revalidated as open from the official source at task time. */
  lead: OfficialLeadRow;
  /** Decrypted through the per-candidate broker grant. */
  profileBytes: Uint8Array;
  privateWorkDirectory: string;
  privateBrowserDirectory: string;
}

export type HostedPreviewOutcome = {
  status: "ready-for-review" | "needs-human";
  blockers: string[];
  job: OfficialJobIdentity;
  resumeSha256: string;
  uploaded: boolean;
};

export interface HostedPreviewDependencies {
  /** A renderer must compile the exact generated source into a private PDF. */
  renderResume(source: ResumeSource, job: DiscoveredJob, candidate: CandidateProfile,
    privateWorkDirectory: string): Promise<string>;
  launch?: typeof launchBrowser;
  verify?: typeof verifyResumePdf;
  /** Controlled transport for the browser fixture; production uses route.fetch. */
  fetchRequest?: (route: Route) => Promise<PreviewFetchedResponse>;
  now?: Date;
}

export interface PreviewFetchedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

async function fetchWithoutRedirect(route: Route): Promise<PreviewFetchedResponse> {
  const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
  return { status: response.status(), headers: response.headers(), body: await response.body() };
}

export function boundJob(lead: OfficialLeadRow, expected: OfficialJobIdentity, now: Date): DiscoveredJob {
  if (lead.sk !== "VERIFIED" || lead.status !== "open" || lead.pk !== `LEAD#${lead.leadId}`
    || lead.jobKey !== officialJobKey(expected) || officialJobKey(lead.job) !== lead.jobKey
    || !Number.isSafeInteger(lead.expiresAt) || lead.expiresAt <= Math.floor(now.getTime() / 1000)) {
    throw new Error("Trusted official lead is unavailable for this run");
  }
  // Official API application links may add a terminal form step. Validate the
  // underlying posting identity, then navigate the original exact URL.
  const identityUrl = new URL(lead.canonicalUrl);
  const parts = identityUrl.pathname.split("/").filter(Boolean);
  if (["apply", "application"].includes(parts.at(-1)?.toLowerCase() ?? "")) {
    parts.pop();
    identityUrl.pathname = `/${parts.join("/")}`;
  }
  const official = officialSourceForLead(identityUrl.href);
  if (!official || official.source.provider !== lead.job.provider.toLowerCase()
    || official.postingId.toLowerCase() !== lead.job.requisitionId.toLowerCase()) {
    throw new Error("Official lead URL does not identify the trusted requisition");
  }
  const employerId = lead.job.employerId.toLowerCase();
  const source = official.source;
  const sourceEmployer = source.provider === "greenhouse" ? source.boardToken
    : source.provider === "ashby" ? source.boardName
      : source.provider === "lever" ? source.site
        : source.provider === "smartrecruiters" ? source.companyIdentifier : "";
  if (sourceEmployer.toLowerCase() !== employerId
    || lead.provenance.provider !== source.provider
    || !lead.provenance.title.trim() || !lead.provenance.company.trim()
    || !lead.provenance.descriptionText.trim()) {
    throw new Error("Official lead metadata is inconsistent with its employer");
  }
  const id = `${source.provider}:${employerId}:${lead.job.requisitionId.toLowerCase()}`;
  return {
    id, provider: source.provider, company: lead.provenance.company,
    title: lead.provenance.title, descriptionText: lead.provenance.descriptionText,
    applicationUrl: lead.canonicalUrl, sourceUrl: lead.provenance.sourceUrl,
    sourcePublishedAt: lead.provenance.sourcePublishedAt, sourceUpdatedAt: null,
    location: null, department: null, employmentType: null, workplaceType: null,
    compensation: null, firstSeenAt: lead.verifiedAt, discoveredAt: lead.verifiedAt,
    isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [],
  };
}

function soleSubmit(snapshot: BrowserSnapshot): boolean {
  const controls = snapshot.controls.filter(control => control.type === "submit"
    || (control.tag === "button" && /^(submit|submit application|send application)$/i.test(control.name)));
  return controls.length === 1;
}

/** Staging preview only: navigates, uploads an exact-job verified résumé, and
 * fills known fields. All HTTP write methods are blocked; it never calls
 * AgentBrowser.submit or the durable final intent API, and closes Chromium. */
export async function runHostedPreSubmitPreview(input: HostedPreviewInput,
  dependencies: HostedPreviewDependencies): Promise<HostedPreviewOutcome> {
  if (!isAbsolute(input.privateWorkDirectory) || !isAbsolute(input.privateBrowserDirectory)) {
    throw new Error("Cloud preview requires absolute private directories");
  }
  let absoluteResume: string | undefined;
  let runtime: BrowserRuntime | undefined;
  let blockedMutationCount = 0;
  let blockedHostCount = 0;
  let blockedRedirectCount = 0;
  let blockedSocketCount = 0;
  const workDirectory = resolve(input.privateWorkDirectory);
  try {
    const now = dependencies.now ?? new Date();
    const job = boundJob(input.lead, input.runJob, now);
    const candidate = parseApprovedHostedProfile(input.profileBytes, input.candidateId);
    const source = createJakeResumeSource(await readBundledJakeTemplate(), job, candidate);
    const resumePath = await dependencies.renderResume(source, job, candidate, input.privateWorkDirectory);
    const rendered = resolve(resumePath);
    if (rendered === workDirectory || !rendered.startsWith(`${workDirectory}${sep}`)) {
      throw new Error("Rendered résumé left the private work directory");
    }
    absoluteResume = rendered;
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
    const approvedHost = new URL(job.applicationUrl).hostname.toLowerCase();
    // Even ordinary field filling can trigger JavaScript writes or WebSocket
    // messages. Install both gates before navigation. Fetch one response at a
    // time without following redirects, so the browser never loads redirected
    // content before we can check its destination.
    await runtime.context.routeWebSocket("**/*", socket => {
      blockedSocketCount++;
      socket.close({ code: 1008, reason: "Preview connections are disabled" });
    });
    await runtime.context.route("**/*", async route => {
      const request = route.request();
      let requestUrl: URL;
      try { requestUrl = new URL(request.url()); }
      catch {
        blockedHostCount++;
        await route.abort("blockedbyclient");
        return;
      }
      if (requestUrl.protocol !== "https:" || requestUrl.hostname.toLowerCase() !== approvedHost
        || requestUrl.port || requestUrl.username || requestUrl.password) {
        blockedHostCount++;
        await route.abort("blockedbyclient");
        return;
      }
      if (!["GET", "HEAD"].includes(request.method().toUpperCase())) {
        blockedMutationCount++;
        await route.abort("blockedbyclient");
        return;
      }
      const response = await (dependencies.fetchRequest ?? fetchWithoutRedirect)(route);
      if (response.status >= 300 && response.status < 400) {
        blockedRedirectCount++;
        await route.abort("blockedbyclient");
        return;
      }
      const headers = { ...response.headers };
      delete headers["content-length"];
      delete headers["content-encoding"];
      await route.fulfill({ status: response.status, headers, body: response.body });
    });
    const browser = new AgentBrowser(runtime.context,
      new Set([approvedHost]),
      new Map([[rendered, artifact.pdfSha256]]));
    let initial: BrowserSnapshot;
    try { initial = await browser.navigate(job.applicationUrl); }
    catch (error) {
      if (!blockedRedirectCount && !blockedHostCount) throw error;
      return { status: "needs-human", blockers: ["Employer form redirected or loaded another host during preview"],
        job: input.runJob, resumeSha256: artifact.pdfSha256, uploaded: false };
    }
    if (!isOriginalRequisition(initial, job)) {
      throw new Error("Employer form is not bound to the trusted requisition");
    }
    const filled = await fillApplicationForm(browser, initial, candidate, rendered,
      { provider: job.provider });
    const blockers = [...filled.blockers];
    if (blockedMutationCount > 0) blockers.push("Employer form attempted a write during preview");
    if (blockedSocketCount > 0) blockers.push("Employer form attempted a WebSocket during preview");
    if (blockedHostCount > 0 || blockedRedirectCount > 0) {
      blockers.push("Employer form redirected or loaded another host during preview");
    }
    if (!filled.uploaded) blockers.push("Résumé was not uploaded");
    if (!soleSubmit(filled.snapshot)) blockers.push("Final submit control needs human review");
    return { status: blockers.length ? "needs-human" : "ready-for-review", blockers,
      job: input.runJob, resumeSha256: artifact.pdfSha256, uploaded: filled.uploaded };
  } finally {
    try { await runtime?.close(); }
    finally {
      if (absoluteResume) await unlink(absoluteResume).catch(() => {});
      input.profileBytes.fill(0);
    }
  }
}
