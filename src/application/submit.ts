import type { ApplicationWorkflow } from "./state-machine.js";
import type { ApplicationHandoff } from "./handoff.js";
import { hasConflictingReceiptUrl } from "./requisition.js";

export interface SubmissionBrowser {
  currentUrl(): string;
  submit(ref: string, expectedConfirmation: string): Promise<string>;
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
): Promise<void> {
  const current = await workflow.current(jobId);
  const host = new URL(handoff.applicationUrl).hostname;
  const page = new URL(browser.currentUrl());
  if (handoff.mode !== "submit-after-approval" || handoff.stopConditions.includes("final-submit")
    || handoff.jobId !== jobId
    || current?.officialUrl !== handoff.applicationUrl || !current.artifactSha256
    || !current.sourceFingerprint || !handoff.allowedDomains.includes(host)
    || page.protocol !== "https:" || page.hostname !== host || page.username || page.password
    || page.href !== new URL(approvedFinalUrl ?? handoff.applicationUrl).href) {
    throw new Error("Application submission is not authorized for this job and destination");
  }
  const pageId = browser.pageId?.();
  const groupId = browser.groupId?.();
  const endpoint = browserEndpoint ?? current.browserEndpoint;
  if (pageId && (!groupId || !endpoint)) {
    throw new Error("BrowserOS submission lacks its saved browser identity");
  }
  await workflow.advance(jobId, "submit-claimed", pageId ? { browserPageId: pageId,
    browserGroupId: groupId!, browserEndpoint: endpoint! } : {});
  try {
    const confirmation = await browser.submit(submitRef, expectedConfirmation);
    if (hasConflictingReceiptUrl(jobId, handoff.applicationUrl, browser.currentUrl())) {
      throw new Error("Employer receipt belongs to a different requisition");
    }
    await workflow.advance(jobId, "submitted", { confirmation });
  } catch (error) {
    await workflow.advance(jobId, "submission-uncertain", {
      blocker: "Submission outcome is unknown; inspect the employer portal before updating status",
    });
    throw error;
  }
}
