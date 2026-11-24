import type { ApplicationWorkflow } from "./state-machine.js";

export interface SubmissionBrowser {
  submit(ref: string, expectedConfirmation: string): Promise<string>;
}

export async function submitApplication(
  workflow: ApplicationWorkflow,
  browser: SubmissionBrowser,
  jobId: string,
  submitRef: string,
  expectedConfirmation: string,
): Promise<void> {
  await workflow.advance(jobId, "submit-claimed");
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
