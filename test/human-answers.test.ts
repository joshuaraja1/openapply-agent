import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadApprovedHumanAnswers } from "../src/application/human-answers.js";

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
});
