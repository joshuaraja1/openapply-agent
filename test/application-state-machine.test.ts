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
    expect((await workflow.advance("job-2", "applying")).stage).toBe("applying");
  });
});
