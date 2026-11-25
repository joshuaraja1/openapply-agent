import { describe, expect, it } from "vitest";
import { createApplicationHandoff } from "../src/application/handoff.js";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { submitApplication } from "../src/application/submit.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { DiscoveredJob } from "../src/types.js";

async function readyWorkflow(job: DiscoveredJob) {
  const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore());
  await workflow.create(job.id, job.applicationUrl);
  for (const stage of ["validated", "matched", "tailored"] as const) {
    await workflow.advance(job.id, stage);
  }
  await workflow.advance(job.id, "rendered", { artifactPath: "/synthetic/resume.pdf",
    artifactSha256: "a".repeat(64), sourceFingerprint: "f".repeat(64) });
  await workflow.advance(job.id, "applying");
  return workflow;
}

describe("submission crash and retry stress", () => {
  it("never makes a second final click across 1,000 uncertain outcomes", async () => {
    let totalClicks = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const reference = String(100_000 + index);
      const applicationUrl = `https://jobs.example.com/apply/${reference}`;
      const job: DiscoveredJob = { id: `greenhouse:example:${reference}`, provider: "greenhouse",
        company: "Example Co", title: "Software Engineer", descriptionText: "Synthetic job",
        applicationUrl, sourceUrl: applicationUrl, location: null, department: null,
        employmentType: null, workplaceType: null, compensation: null,
        sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-11-24T00:00:00Z",
        discoveredAt: "2026-11-24T00:00:00Z", isNew: true, isFresh: true,
        freshnessBasis: "first-seen", matchedKeywords: [] };
      const workflow = await readyWorkflow(job);
      const handoff = createApplicationHandoff(job, false);
      let currentUrl = applicationUrl;
      let clicks = 0;
      const browser = { currentUrl: () => currentUrl,
        submit: async () => {
          clicks += 1;
          totalClicks += 1;
          if (index % 2 === 0) throw new Error("Renderer crashed after click");
          currentUrl = "https://jobs.example.com/apply/999999";
          return "Thank you for applying";
        } };
      await expect(submitApplication(workflow, browser, job.id, "submit-ref",
        "Thank you for applying", handoff)).rejects.toThrow();
      expect((await workflow.current(job.id))?.stage).toBe("submission-uncertain");
      await expect(submitApplication(workflow, browser, job.id, "submit-ref",
        "Thank you for applying", handoff)).rejects.toThrow();
      expect(clicks).toBe(1);
    }
    expect(totalClicks).toBe(1_000);
  });
});
