import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

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
  if (process.platform === "win32") throw new Error("Private answer approval needs Windows ACL support");
  if (!isAbsolute(path)) throw new Error("Approved answers need an absolute private path");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (info.mode & 0o077) !== 0) {
    throw new Error("Approved answers file must be private to this user");
  }
  const parsed = answerApprovalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (parsed.jobId !== jobId || parsed.browserPageId !== browserPageId) {
    throw new Error("Approved answers belong to another application tab");
  }
  const answers = new Map(parsed.answers.map((entry) => [entry.field, entry.value]));
  if (answers.size !== parsed.answers.length) throw new Error("Approved answer labels must be unique");
  return { jobId, browserPageId, approveFinalSubmission: true, answers };
}
