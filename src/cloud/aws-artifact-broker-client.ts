import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { ScopedArtifactCredentials } from "./artifact-credential-broker.js";

const grantSchema = z.strictObject({ candidateId: z.uuid(), runId: z.uuid(), leaseToken: z.uuid(),
  accessKeyId: z.string().min(8).max(128), secretAccessKey: z.string().min(8).max(256),
  sessionToken: z.string().min(8).max(8192), expiresAt: z.iso.datetime() });
const uploadSchema = z.strictObject({ candidateId: z.uuid(), runId: z.uuid(),
  artifactId: z.uuid() });

function validateBrokerArn(functionArn: string, capability: string): void {
  if (!/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:openapply-[a-z0-9-]+-artifact-broker$/.test(functionArn)
    || !capability || capability.length > 800) {
    throw new Error("Artifact broker invocation is invalid");
  }
}

/** Task role needs only lambda:InvokeFunction on this exact broker function.
 * No bearer capability or STS credential is sent to logs or a queue. */
export async function requestScopedArtifactCredentials(
  lambda: Pick<LambdaClient, "send">, functionArn: string, capability: string,
  expected: { candidateId: string; runId: string; leaseToken: string }, now = new Date(),
): Promise<ScopedArtifactCredentials> {
  validateBrokerArn(functionArn, capability);
  const result = await lambda.send(new InvokeCommand({ FunctionName: functionArn,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ kind: "credentials", capability,
      leaseToken: expected.leaseToken }), "utf8") }));
  if (result.StatusCode !== 200 || result.FunctionError || !result.Payload
    || result.Payload.byteLength > 12_000) {
    throw new Error("Scoped artifact credentials unavailable");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.Payload)); }
  catch { throw new Error("Scoped artifact credentials unavailable"); }
  const parsed = grantSchema.safeParse(value);
  if (!parsed.success || parsed.data.candidateId !== expected.candidateId
    || parsed.data.runId !== expected.runId || parsed.data.leaseToken !== expected.leaseToken
    || Date.parse(parsed.data.expiresAt) <= now.getTime() + 60_000) {
    throw new Error("Scoped artifact credentials unavailable");
  }
  return parsed.data;
}

/** Uploads an already encrypted receipt. The task role has no S3 Put access;
 * the broker checks the durable reserved ID and makes one conditional write. */
export async function uploadEncryptedReceipt(lambda: Pick<LambdaClient, "send">,
  functionArn: string, capability: string,
  expected: { candidateId: string; runId: string; leaseToken: string; artifactId: string },
  body: Uint8Array): Promise<void> {
  validateBrokerArn(functionArn, capability);
  if (body.byteLength === 0 || body.byteLength > 1_600_000) {
    throw new Error("Receipt envelope is oversized");
  }
  const result = await lambda.send(new InvokeCommand({ FunctionName: functionArn,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify({ kind: "receipt-upload", capability,
      leaseToken: expected.leaseToken, artifactId: expected.artifactId,
      bodyBase64: Buffer.from(body).toString("base64") }), "utf8") }));
  if (result.StatusCode !== 200 || result.FunctionError || !result.Payload
    || result.Payload.byteLength > 2048) throw new Error("Receipt upload unavailable");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.Payload)); }
  catch { throw new Error("Receipt upload unavailable"); }
  const parsed = uploadSchema.safeParse(value);
  if (!parsed.success || parsed.data.candidateId !== expected.candidateId
    || parsed.data.runId !== expected.runId || parsed.data.artifactId !== expected.artifactId) {
    throw new Error("Receipt upload unavailable");
  }
}
