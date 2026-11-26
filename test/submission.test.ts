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

async function ready(jobId = "job", applicationUrl = "https://jobs.example.com/job") {
  const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
  const workflow = new ApplicationWorkflow(store);
  await workflow.create(jobId, applicationUrl);
  await workflow.advance(jobId, "validated");
  await workflow.advance(jobId, "matched");
  await workflow.advance(jobId, "tailored");
  await workflow.advance(jobId, "rendered", { artifactPath: "/private/job.pdf",
    artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
  await workflow.advance(jobId, "applying");
  return { store, workflow };
}

describe("submission verification", () => {
  it("rechecks provider policy after durable claim and never clicks after revocation", async () => {
    const { workflow } = await ready();
    const submit = vi.fn(async () => "Thank you for applying");
    const browser = { currentUrl: () => handoff.applicationUrl, submit };
    let revoked = false;
    const advance = workflow.advance.bind(workflow);
    vi.spyOn(workflow, "advance").mockImplementation(async (jobId, stage, details) => {
      const checkpoint = await advance(jobId, stage, details);
      if (stage === "submit-claimed") revoked = true;
      return checkpoint;
    });
    await submitApplication(workflow, browser, "job", "1:0", "Thank you for applying",
      handoff, undefined, undefined, undefined, undefined,
      async () => revoked ? "Provider revoked after claim" : undefined);
    expect(submit).not.toHaveBeenCalled();
    expect(await workflow.current("job")).toMatchObject({ stage: "submission-uncertain",
      blocker: expect.stringContaining("no final click was attempted") });
  });

  it("marks a generic thank-you receipt uncertain when it redirects to another requisition", async () => {
    const jobId = "greenhouse:example:123456";
    const applicationUrl = "https://jobs.example.com/apply/123456";
    const { workflow } = await ready(jobId, applicationUrl);
    const boundHandoff = { ...handoff, jobId, applicationUrl };
    let currentUrl = applicationUrl;
    const browser = { currentUrl: () => currentUrl,
      submit: vi.fn(async () => { currentUrl = "https://jobs.example.com/apply/654321/thank-you";
        return "Thank you for applying"; }) };
    await expect(submitApplication(workflow, browser, jobId, "1:0",
      "Thank you for applying", boundHandoff)).rejects.toThrow("not bound to the original requisition");
    expect((await workflow.current(jobId))?.stage).toBe("submission-uncertain");
    expect(browser.submit).toHaveBeenCalledOnce();
  });
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
