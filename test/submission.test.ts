import { describe, expect, it, vi } from "vitest";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { submitApplication } from "../src/application/submit.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";
import type { ApplicationHandoff } from "../src/application/handoff.js";

const handoff: ApplicationHandoff = {
  version: 1,
  jobId: "job",
  applicationUrl: "https://jobs.example.com/job",
  mode: "submit-after-approval",
  allowedDomains: ["jobs.example.com"],
  requiredArtifacts: ["resume"],
  stopConditions: ["captcha"],
};

async function ready() {
  const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
  const workflow = new ApplicationWorkflow(store);
  await workflow.create("job", "https://jobs.example.com/job");
  await workflow.advance("job", "validated");
  await workflow.advance("job", "matched");
  await workflow.advance("job", "tailored");
  await workflow.advance("job", "rendered", { artifactPath: "/private/job.pdf",
    artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
  await workflow.advance("job", "applying");
  return { store, workflow };
}

describe("submission verification", () => {
  it("records submitted only after an employer receipt", async () => {
    const { store, workflow } = await ready();
    const browser = { currentUrl: () => handoff.applicationUrl, submit: vi.fn(async () => "Thank you for applying") };
    await submitApplication(workflow, browser, "job", "1:0", "Thank you for applying", handoff);
    expect((await store.read("job"))?.state).toMatchObject({ stage: "submitted", confirmation: "Thank you for applying" });
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you for applying", handoff))
      .rejects.toThrow("Invalid");
    expect(browser.submit).toHaveBeenCalledOnce();
  });

  it("records uncertainty after a click whose outcome cannot be verified", async () => {
    const { store, workflow } = await ready();
    const browser = { currentUrl: () => handoff.applicationUrl, submit: vi.fn(async () => { throw new Error("confirmation timed out"); }) };
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you", handoff))
      .rejects.toThrow("confirmation timed out");
    expect((await store.read("job"))?.state.stage).toBe("submission-uncertain");
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you", handoff))
      .rejects.toThrow("Invalid");
    expect(browser.submit).toHaveBeenCalledOnce();
  });

  it("rejects prepare-only and wrong-destination handoffs before claiming", async () => {
    const { store, workflow } = await ready();
    const browser = { currentUrl: () => handoff.applicationUrl, submit: vi.fn(async () => "Thank you") };
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you", { ...handoff, mode: "prepare" }))
      .rejects.toThrow("not authorized");
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you",
      { ...handoff, stopConditions: ["captcha", "final-submit"] })).rejects.toThrow("not authorized");
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you", { ...handoff, applicationUrl: "https://wrong.example/job" }))
      .rejects.toThrow("not authorized");
    const wrongTab = { currentUrl: () => "https://jobs.example.com/another-job", submit: browser.submit };
    await expect(submitApplication(workflow, wrongTab, "job", "1:0", "Thank you", handoff))
      .rejects.toThrow("not authorized");
    expect(browser.submit).not.toHaveBeenCalled();
    expect((await store.read("job"))?.state.stage).toBe("applying");
  });
});
