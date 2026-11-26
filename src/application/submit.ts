import type { ApplicationWorkflow } from "./state-machine.js";
import type { ApplicationHandoff } from "./handoff.js";
import { hasUnboundReceiptUrl } from "./requisition.js";

export interface SubmissionBrowser {
  currentUrl(): string;
  submit(ref: string, expectedConfirmation: string): Promise<string>;
  receiptContext?(): Promise<string>;
  pageId?(): number | undefined;
  groupId?(): string | undefined;
}

export async function submitApplication(
  workflow: ApplicationWorkflow,
  browser: SubmissionBrowser,
  jobId: string,
  submitRef: string,
  expectedConfirmation: string,
  handoff: ApplicationHandoff,
  browserEndpoint?: string,
  approvedFinalUrl?: string,
  packagePath?: string,
  packageSha256?: string,
  beforeClick?: () => Promise<string | undefined>,
  receiptJob?: { company: string; title: string },
): Promise<void> {
  const current = await workflow.current(jobId);
  const host = new URL(handoff.applicationUrl).hostname;
  const page = new URL(browser.currentUrl());
  if (handoff.mode !== "submit-after-approval" || handoff.stopConditions.includes("final-submit")
    || handoff.jobId !== jobId
    || current?.officialUrl !== handoff.applicationUrl || !current.artifactSha256
    || !current.sourceFingerprint || !handoff.allowedDomains.includes(host)
    || page.protocol !== "https:" || page.hostname !== host
    || page.origin !== new URL(handoff.applicationUrl).origin || page.username || page.password
    || page.href !== new URL(approvedFinalUrl ?? handoff.applicationUrl).href) {
    throw new Error("Application submission is not authorized for this job and destination");
  }
  const pageId = browser.pageId?.();
  const groupId = browser.groupId?.();
  const endpoint = browserEndpoint ?? current.browserEndpoint;
  if (pageId && (!groupId || !endpoint)) {
    throw new Error("BrowserOS submission lacks its saved browser identity");
  }
  await workflow.advance(jobId, "submit-claimed", {
    browserPageUrl: browser.currentUrl(),
    ...(pageId ? { browserPageId: pageId, browserGroupId: groupId!, browserEndpoint: endpoint! } : {}),
    ...(packagePath ? { packagePath } : {}),
    ...(packageSha256 ? { packageSha256 } : {}),
  });
  // The durable claim prevents any restart from repeating the final click.
  // Recheck mutable local policy after the claim and immediately before the
  // browser action; a denied claim remains conservative and requires review.
  let policyBlocker: string | undefined;
  try { policyBlocker = await beforeClick?.(); }
  catch { policyBlocker = "Private provider policy is unavailable before the final click"; }
  if (policyBlocker) {
    await workflow.advance(jobId, "submission-uncertain", {
      blocker: `${policyBlocker}; no final click was attempted in this run`,
    });
    return;
  }
  try {
    const confirmation = await browser.submit(submitRef, expectedConfirmation);
    // A generic thank-you on the same URL does not prove which job was received.
    // Inspect all bounded post-click text for contradictions, but require the
    // actual confirmation line to identify the approved job.
    const context = await browser.receiptContext?.() ?? confirmation;
    const identity = (line: string) =>
      /\bapplying to\s+(.+?)\s+as\s+([^"\r\n]+?)(?:"|\s+\[|$)/i.exec(line);
    const matchesJob = (match: RegExpExecArray) => receiptJob
      && match[1]!.trim().toLowerCase() === receiptJob.company.trim().toLowerCase()
      && match[2]!.trim().toLowerCase() === receiptJob.title.trim().toLowerCase();
    if (receiptJob) {
      const contextIdentities = context.split(/\r?\n/).map(identity).filter((match) => match !== null);
      if (contextIdentities.some((match) => !matchesJob(match))) {
        throw new Error("Employer receipt identifies another job");
      }
      const confirmationIdentities = confirmation.split(/\r?\n/).map(identity).filter((match) => match !== null);
      const requisition = jobId.split(":").at(-1) ?? "";
      const confirmationContainsRequisition = /^[a-z0-9_-]{6,}$/i.test(requisition)
        && new RegExp(`(?:^|[^a-z0-9_-])${requisition}(?:$|[^a-z0-9_-])`, "i").test(confirmation);
      if (!confirmationIdentities.some(matchesJob) && !confirmationContainsRequisition) {
        throw new Error("Employer confirmation does not identify the original job");
      }
    }
    if (hasUnboundReceiptUrl(jobId, handoff.applicationUrl, browser.currentUrl())) {
      throw new Error("Employer receipt is not bound to the original requisition");
    }
    await workflow.advance(jobId, "submitted", { confirmation });
  } catch (error) {
    await workflow.advance(jobId, "submission-uncertain", {
      blocker: "Submission outcome is unknown; inspect the employer portal before updating status",
    });
    throw error;
  }
}
