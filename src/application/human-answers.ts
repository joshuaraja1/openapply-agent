import { isAbsolute } from "node:path";
import { z } from "zod";
import { readPrivateFile } from "../storage/private-path.js";

const answerApprovalSchema = z.object({
  version: z.literal(1), jobId: z.string().min(1), browserPageId: z.number().int().nonnegative(),
  approveFinalSubmission: z.literal(true),
  answers: z.array(z.object({ field: z.string().min(1), value: z.string().min(1) })),
});

export interface HumanAnswerApproval {
  jobId: string;
  browserPageId: number;
  approveFinalSubmission: true;
  answers: ReadonlyMap<string, string>;
}

function parseApprovedHumanAnswers(
  text: string, jobId: string, browserPageId: number,
): HumanAnswerApproval {
  const parsed = answerApprovalSchema.parse(JSON.parse(text));
  if (parsed.jobId !== jobId || parsed.browserPageId !== browserPageId) {
    throw new Error("Approved answers belong to another application tab");
  }
  const answers = new Map(parsed.answers.map((entry) => [entry.field, entry.value]));
  if (answers.size !== parsed.answers.length) throw new Error("Approved answer labels must be unique");
  return { jobId, browserPageId, approveFinalSubmission: true, answers };
}

export async function loadApprovedHumanAnswers(
  path: string, jobId: string, browserPageId: number,
): Promise<HumanAnswerApproval> {
  if (!isAbsolute(path)) throw new Error("Approved answers need an absolute private path");
  return parseApprovedHumanAnswers(await readPrivateFile(path), jobId, browserPageId);
}

/** Read the local handoff UI's answers through a one-shot child-process pipe. */
export async function loadApprovedHumanAnswersFromStream(
  stream: AsyncIterable<Buffer | string>, jobId: string, browserPageId: number,
): Promise<HumanAnswerApproval> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 50_000) throw new Error("Approved answers exceed the handoff limit");
    chunks.push(data);
  }
  return parseApprovedHumanAnswers(Buffer.concat(chunks).toString("utf8"), jobId, browserPageId);
}
