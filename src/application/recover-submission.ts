import { assertWorkflowLeaseHeld } from "../storage/workflow-lease.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";

/** A crash after the durable final-click claim must never trigger another click. */
export async function recoverClaimedSubmission(workflow: ApplicationWorkflow,
  saved: ApplicationCheckpoint, stateRoot: string): Promise<ApplicationCheckpoint> {
  assertWorkflowLeaseHeld(stateRoot);
  if (saved.stage !== "submit-claimed") throw new Error("No interrupted submission claim to recover");
  const current = await workflow.current(saved.jobId);
  if (!current || current.jobId !== saved.jobId || current.officialUrl !== saved.officialUrl) {
    throw new Error("Interrupted submission no longer matches its saved job and URL");
  }
  if (current.stage === "submission-uncertain") return current;
  if (current.stage !== "submit-claimed") throw new Error("Interrupted submission changed before recovery");
  return workflow.advance(saved.jobId, "submission-uncertain", {
    blocker: "The previous run ended after the final submission was claimed; inspect the employer portal before confirming this job",
  });
}
