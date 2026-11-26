import { ResumeVisualReviewRequiredError } from "../resume/visual-qa.js";
import type { DiscoveredJob } from "../types.js";
import { ApplicationWorkflow, needsResumeVisualReview, resumeVisualReviewPrefix,
  type ApplicationCheckpoint } from "./state-machine.js";

/** Persist a pre-upload PDF review so a crash cannot silently retry the upload. */
export async function recordResumeVisualReview(workflow: ApplicationWorkflow, job: DiscoveredJob,
  error: ResumeVisualReviewRequiredError): Promise<ApplicationCheckpoint> {
  let checkpoint = await workflow.current(job.id) ?? await workflow.create(job.id, job.applicationUrl);
  if (checkpoint.officialUrl !== job.applicationUrl) {
    throw new Error("Résumé review checkpoint belongs to another employer destination");
  }
  for (const stage of ["validated", "matched", "tailored"] as const) {
    if (checkpoint.stage === ({ validated: "discovered", matched: "validated", tailored: "matched" } as const)[stage]) {
      checkpoint = await workflow.advance(job.id, stage);
    }
  }
  if (checkpoint.stage === "tailored") {
    checkpoint = await workflow.advance(job.id, "blocked", {
      blocker: `${resumeVisualReviewPrefix} ${error.message}${error.artifactPath ? ` Inspect ${error.artifactPath}` : ""}`,
    });
  }
  if (!needsResumeVisualReview(checkpoint)) {
    throw new Error("Résumé visual review cannot replace a later application checkpoint");
  }
  return checkpoint;
}
