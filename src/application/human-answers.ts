import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { assertPrivateFile } from "../storage/private-path.js";

const answerApprovalSchema = z.object({
  version: z.literal(1), jobId: z.string().min(1), browserPageId: z.number().int().positive(),
  approveFinalSubmission: z.literal(true),
  answers: z.array(z.object({ field: z.string().min(1), value: z.string().min(1) })),
});

export interface HumanAnswerApproval {
  jobId: string;
  browserPageId: number;
  approveFinalSubmission: true;
  answers: ReadonlyMap<string, string>;
}

export async function loadApprovedHumanAnswers(
  path: string, jobId: string, browserPageId: number,
): Promise<HumanAnswerApproval> {
  if (!isAbsolute(path)) throw new Error("Approved answers need an absolute private path");
  await assertPrivateFile(path);
  const parsed = answerApprovalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (parsed.jobId !== jobId || parsed.browserPageId !== browserPageId) {
    throw new Error("Approved answers belong to another application tab");
  }
  const answers = new Map(parsed.answers.map((entry) => [entry.field, entry.value]));
  if (answers.size !== parsed.answers.length) throw new Error("Approved answer labels must be unique");
  return { jobId, browserPageId, approveFinalSubmission: true, answers };
}
