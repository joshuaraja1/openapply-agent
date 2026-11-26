import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadApprovedHumanAnswers, loadApprovedHumanAnswersFromStream }
  from "../src/application/human-answers.js";

describe("exact human answer approval", () => {
  it("binds private answers to a job and BrowserOS tab", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-answers-"));
    try {
      const path = join(root, "answers.json");
      await writeFile(path, JSON.stringify({ version: 1, jobId: "job-1", browserPageId: 7,
        approveFinalSubmission: true,
        answers: [{ field: "Salary expectation", value: "Negotiable" }] }), { mode: 0o600 });
      expect((await loadApprovedHumanAnswers(path, "job-1", 7)).answers.get("Salary expectation")).toBe("Negotiable");
      await expect(loadApprovedHumanAnswers(path, "job-1", 8)).rejects.toThrow("another application tab");
      await chmod(path, 0o644);
      await expect(loadApprovedHumanAnswers(path, "job-1", 7)).rejects.toThrow("unsafe permissions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts page ID zero only when the expected owned-browser handoff is job-bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-owned-answers-"));
    try {
      const path = join(root, "answers.json");
      await writeFile(path, JSON.stringify({ version: 1, jobId: "job-2", browserPageId: 0,
        approveFinalSubmission: true, answers: [{ field: "Salary expectation", value: "125000" }] }),
      { mode: 0o600 });
      expect((await loadApprovedHumanAnswers(path, "job-2", 0)).answers.get("Salary expectation"))
        .toBe("125000");
      await expect(loadApprovedHumanAnswers(path, "job-3", 0)).rejects.toThrow("another application tab");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads private UI answers from a bounded pipe without creating a file", async () => {
    const json = JSON.stringify({ version: 1, jobId: "job-3", browserPageId: 0,
      approveFinalSubmission: true, answers: [{ field: "Required question", value: "Approved answer" }] });
    const stream = () => Readable.from([json.slice(0, 30), json.slice(30)]);
    expect((await loadApprovedHumanAnswersFromStream(stream(), "job-3", 0))
      .answers.get("Required question")).toBe("Approved answer");
    await expect(loadApprovedHumanAnswersFromStream(stream(), "other-job", 0))
      .rejects.toThrow("another application tab");
    await expect(loadApprovedHumanAnswersFromStream(Readable.from(["x".repeat(50_001)]), "job-3", 0))
      .rejects.toThrow("handoff limit");
  });
});
