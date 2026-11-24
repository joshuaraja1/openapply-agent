import { describe, expect, it } from "vitest";
import { ApplicationWorkflow } from "../src/application/state-machine.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { ApplicationCheckpoint } from "../src/application/state-machine.js";

describe("application workflow", () => {
  it("requires a verified artifact and employer confirmation", async () => {
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore<ApplicationCheckpoint>());
    await workflow.create("job-1", "https://jobs.example.com/1");
    await expect(workflow.create("job-1", "https://jobs.example.com/1")).rejects.toThrow("already exists");
    await workflow.advance("job-1", "validated");
    await workflow.advance("job-1", "matched");
    await workflow.advance("job-1", "tailored");
    await expect(workflow.advance("job-1", "rendered")).rejects.toThrow("artifact");
    await workflow.advance("job-1", "rendered", { artifactPath: "/private/job-1.pdf" });
    await workflow.advance("job-1", "applying");
    await workflow.advance("job-1", "submit-claimed");
    await expect(workflow.advance("job-1", "submitted")).rejects.toThrow("confirmation");
    expect((await workflow.advance("job-1", "submitted", { confirmation: "Application 123" })).stage).toBe("submitted");
    await expect(workflow.advance("job-1", "applying")).rejects.toThrow("Invalid");
  });

  it("records a blocker before resuming", async () => {
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore<ApplicationCheckpoint>());
    await workflow.create("job-2", "https://jobs.example.com/2");
    await workflow.advance("job-2", "validated");
    await workflow.advance("job-2", "matched");
    await workflow.advance("job-2", "tailored");
    await workflow.advance("job-2", "rendered", { artifactPath: "/private/job-2.pdf" });
    await workflow.advance("job-2", "applying");
    await expect(workflow.advance("job-2", "waiting-human")).rejects.toThrow("reason");
    await workflow.advance("job-2", "waiting-human", { blocker: "CAPTCHA" });
    const resumed = await workflow.advance("job-2", "applying");
    expect(resumed.stage).toBe("applying");
    expect(resumed.blocker).toBeUndefined();
  });

  it("blocks resume without an artifact and gives one worker the submit claim", async () => {
    const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
    const first = new ApplicationWorkflow(store);
    const second = new ApplicationWorkflow(store);
    await first.create("job-3", "https://jobs.example.com/3");
    await first.advance("job-3", "validated");
    await first.advance("job-3", "matched");
    await first.advance("job-3", "tailored");
    await first.advance("job-3", "blocked", { blocker: "PDF compile error" });
    await expect(first.advance("job-3", "applying")).rejects.toThrow("artifact");
    await first.advance("job-3", "rendered", { artifactPath: "/private/job-3.pdf" });
    await first.advance("job-3", "applying");
    const claims = await Promise.allSettled([
      first.advance("job-3", "submit-claimed"),
      second.advance("job-3", "submit-claimed"),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    await expect(first.advance("job-3", "applying")).rejects.toThrow("Invalid");
    await first.advance("job-3", "submission-uncertain", { blocker: "Restart after Submit; check employer receipt" });
    await expect(first.advance("job-3", "applying")).rejects.toThrow("Invalid");
    await first.advance("job-3", "submitted", { confirmation: "Employer application 456" });
  });

  it("cannot replace a rendered resume while applying", async () => {
    const workflow = new ApplicationWorkflow(new MemoryApplicationStateStore<ApplicationCheckpoint>());
    await workflow.create("job-4", "https://jobs.example.com/4");
    await workflow.advance("job-4", "validated");
    await workflow.advance("job-4", "matched");
    await workflow.advance("job-4", "tailored");
    await workflow.advance("job-4", "rendered", { artifactPath: "/private/job-4.pdf" });
    await expect(workflow.advance("job-4", "applying", { artifactPath: "/private/other.pdf" }))
      .rejects.toThrow("rendered checkpoint");
  });
});
