import { describe, expect, it } from "vitest";
import { ApplicationWorkflow, needsResumeVisualReview,
  type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { recordResumeVisualReview } from "../src/application/resume-review.js";
import { ResumeVisualReviewRequiredError } from "../src/resume/visual-qa.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

const job = { id: "review-job", applicationUrl: "https://example.com/jobs/review-job" } as DiscoveredJob;

describe("pre-upload résumé review", () => {
  it("persists a blocked checkpoint and keeps repeated alerts idempotent", async () => {
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore<ApplicationCheckpoint>());
    const error = new ResumeVisualReviewRequiredError("low contrast", "/private/resume.pdf");
    const first = await recordResumeVisualReview(workflow, job, error);
    expect(needsResumeVisualReview(first)).toBe(true);
    expect(first.blocker).toContain("/private/resume.pdf");
    const second = await recordResumeVisualReview(workflow, job, error);
    expect(second).toEqual(first);
    await workflow.advance(job.id, "rendered", { artifactPath: "/private/corrected.pdf",
      artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
    await expect(recordResumeVisualReview(workflow, job, error)).rejects.toThrow("later application checkpoint");
  });

  it("refuses a checkpoint tied to a different employer URL", async () => {
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore<ApplicationCheckpoint>());
    await workflow.create(job.id, "https://other.example/jobs/review-job");
    await expect(recordResumeVisualReview(workflow, job,
      new ResumeVisualReviewRequiredError("low contrast"))).rejects.toThrow("another employer");
  });
});
