import { describe, expect, it } from "vitest";
import { runResumeChild } from "../src/application/resume-child.js";

describe("local handoff resume child", () => {
  it("passes approved answers through stdin and waits for the child to finish", async () => {
    const payload = JSON.stringify({ version: 1, jobId: "fixture-job",
      browserPageId: 7, approveFinalSubmission: true,
      answers: [{ field: "Fixture question", value: "Fixture answer" }] });
    const childCode = `let body='';
      process.stdin.on('data', chunk => body += chunk);
      process.stdin.on('end', () => {
        const answer = JSON.parse(body);
        const valid = process.env.OPENAPPLY_APPROVED_ANSWERS_STDIN === '1'
          && !process.env.OPENAPPLY_APPROVED_ANSWERS
          && answer.jobId === 'fixture-job'
          && answer.answers[0].value === 'Fixture answer'
          && !process.argv.join(' ').includes('Fixture answer');
        process.exitCode = valid ? 0 : 2;
      });`;
    await runResumeChild(["-e", childCode],
      { ...process.env, OPENAPPLY_APPROVED_ANSWERS_STDIN: "1",
        OPENAPPLY_APPROVED_ANSWERS: undefined }, payload);
  });

  it("reports a failed child without treating resume as complete", async () => {
    await expect(runResumeChild(["-e", "process.exit(3)"], process.env))
      .rejects.toThrow("Application resume failed");
  });
});
