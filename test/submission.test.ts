import { describe, expect, it, vi } from "vitest";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "../src/application/state-machine.js";
import { submitApplication } from "../src/application/submit.js";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";

async function ready() {
  const store = new MemoryApplicationStateStore<ApplicationCheckpoint>();
  const workflow = new ApplicationWorkflow(store);
  await workflow.create("job", "https://jobs.example.com/job");
  await workflow.advance("job", "validated");
  await workflow.advance("job", "matched");
  await workflow.advance("job", "tailored");
  await workflow.advance("job", "rendered", { artifactPath: "/private/job.pdf" });
  await workflow.advance("job", "applying");
  return { store, workflow };
}

describe("submission verification", () => {
  it("records submitted only after an employer receipt", async () => {
    const { store, workflow } = await ready();
    const browser = { submit: vi.fn(async () => "Thank you for applying") };
    await submitApplication(workflow, browser, "job", "1:0", "Thank you for applying");
    expect((await store.read("job"))?.state).toMatchObject({ stage: "submitted", confirmation: "Thank you for applying" });
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you for applying"))
      .rejects.toThrow("Invalid");
    expect(browser.submit).toHaveBeenCalledOnce();
  });

  it("records uncertainty after a click whose outcome cannot be verified", async () => {
    const { store, workflow } = await ready();
    const browser = { submit: vi.fn(async () => { throw new Error("confirmation timed out"); }) };
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you"))
      .rejects.toThrow("confirmation timed out");
    expect((await store.read("job"))?.state.stage).toBe("submission-uncertain");
    await expect(submitApplication(workflow, browser, "job", "1:0", "Thank you"))
      .rejects.toThrow("Invalid");
    expect(browser.submit).toHaveBeenCalledOnce();
  });
});
