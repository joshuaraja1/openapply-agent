import type { ApplicationWorkflow } from "./state-machine.js";
import type { ApplicationHandoff } from "./handoff.js";

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
): Promise<void> {
  const current = await workflow.current(jobId);
  const host = new URL(handoff.applicationUrl).hostname;
  if (handoff.mode !== "submit-after-approval" || handoff.stopConditions.includes("final-submit")
    || handoff.jobId !== jobId
    || current?.officialUrl !== handoff.applicationUrl || !current.artifactSha256
    || !current.sourceFingerprint || !handoff.allowedDomains.includes(host)
    || new URL(browser.currentUrl()).href !== new URL(handoff.applicationUrl).href) {
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
    await workflow.advance(jobId, "submitted", { confirmation });
  } catch (error) {
    await workflow.advance(jobId, "submission-uncertain", {
      blocker: "Submission outcome is unknown; inspect the employer portal before updating status",
    });
    throw error;
  }
}
