import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { ScopedArtifactCredentials } from "./artifact-credential-broker.js";

const grantSchema = z.strictObject({ candidateId: z.uuid(), runId: z.uuid(),
  accessKeyId: z.string().min(8).max(128), secretAccessKey: z.string().min(8).max(256),
  sessionToken: z.string().min(8).max(8192), expiresAt: z.iso.datetime() });

/** Task role needs only lambda:InvokeFunction on this exact broker function.
 * No bearer capability or STS credential is sent to logs or a queue. */
export async function requestScopedArtifactCredentials(
  lambda: Pick<LambdaClient, "send">, functionArn: string, capability: string,
  expected: { candidateId: string; runId: string }, now = new Date(),
): Promise<ScopedArtifactCredentials> {
  if (!/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:openapply-[a-z0-9-]+-artifact-broker$/.test(functionArn)
    || !capability || capability.length > 800) {
    throw new Error("Artifact broker invocation is invalid");
  }
  const result = await lambda.send(new InvokeCommand({ FunctionName: functionArn,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ capability }), "utf8") }));
  if (result.StatusCode !== 200 || result.FunctionError || !result.Payload
    || result.Payload.byteLength > 12_000) {
    throw new Error("Scoped artifact credentials unavailable");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.Payload)); }
  catch { throw new Error("Scoped artifact credentials unavailable"); }
  const parsed = grantSchema.safeParse(value);
  if (!parsed.success || parsed.data.candidateId !== expected.candidateId
    || parsed.data.runId !== expected.runId
    || Date.parse(parsed.data.expiresAt) <= now.getTime() + 60_000) {
    throw new Error("Scoped artifact credentials unavailable");
  }
  return parsed.data;
}
