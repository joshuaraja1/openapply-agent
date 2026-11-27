import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { CloudRunPorts } from "./queued-run.js";
import type { RunStateRequest } from "./run-state-broker.js";

const uuid = z.uuid().refine(value => value === value.toLowerCase());
const job = z.strictObject({ provider: z.string(), employerId: z.string(), requisitionId: z.string() });
const syntheticJob = z.strictObject({ provider: z.literal("synthetic"),
  employerId: z.literal("fixture"), requisitionId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/) });
const identity = z.strictObject({ subjectId: z.string(), consentVersion: z.number().int().positive(), job });
const submission = z.strictObject({ status: z.enum(["not_started", "confirmed", "needs_reconciliation"]),
  receiptArtifactId: uuid.optional(), receiptSha256: z.string().optional(), runId: uuid.optional() });
const dispatch = z.strictObject({ body: z.string().min(1).max(1024),
  state: z.enum(["queued", "launched"]) });

/** Only this broker Lambda is callable by the browser task role; no raw Dynamo
 * commands, partition keys, or update expressions cross this RPC boundary. */
export function createBrokeredRunState(lambda: Pick<LambdaClient, "send">, functionArn: string,
  capability: string, scope: { candidateId: string; runId: string }):
  Pick<CloudRunPorts, "billing" | "authorization" | "runRecords" | "journal"> & {
    dispatch: { read(): Promise<z.infer<typeof dispatch>>; markCompleted(): Promise<void> };
    syntheticAudit: {
      recordFinalClick(candidate: string, token: string, target: z.infer<typeof syntheticJob>): Promise<boolean>;
      readClickAttempts(candidate: string, target: z.infer<typeof syntheticJob>): Promise<number>;
    } } {
  const candidateId = uuid.parse(scope.candidateId);
  const runId = uuid.parse(scope.runId);
  if (!/^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:openapply-[a-z0-9-]+-artifact-broker$/.test(functionArn)
    || !capability || capability.length > 800) throw new Error("Run state broker unavailable");
  function exact(candidate: string, run?: string): void {
    if (candidate !== candidateId || (run !== undefined && run !== runId)) {
      throw new Error("Run state scope mismatch");
    }
  }
  async function call(command: RunStateRequest): Promise<unknown> {
    const result = await lambda.send(new InvokeCommand({ FunctionName: functionArn,
      InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify({
        kind: "run-state", capability, request: command }), "utf8") }));
    if (result.StatusCode !== 200 || result.FunctionError || !result.Payload
      || result.Payload.byteLength > 32_000) throw new Error("Run state broker unavailable");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.Payload)); }
    catch { throw new Error("Run state broker unavailable"); }
  }
  return {
    billing: { async loadEntitlements(subjectId) {
      return z.array(z.unknown()).parse(await call({ operation: "loadEntitlements", subjectId }));
    } },
    authorization: {
      async ownsRun(candidate, run) { exact(candidate, run);
        return z.boolean().parse(await call({ operation: "ownsRun" })); },
      async hasCurrentConsent(candidate, run) { exact(candidate, run);
        return z.boolean().parse(await call({ operation: "hasCurrentConsent" })); },
    },
    runRecords: {
      async loadIdentity(candidate, run) { exact(candidate, run);
        return identity.parse(await call({ operation: "loadIdentity" })); },
      async loadProfileArtifactId(candidate, run) { exact(candidate, run);
        return uuid.parse(await call({ operation: "loadProfileArtifactId" })); },
    },
    journal: {
      async acquireLease(candidate, run) { exact(candidate, run);
        return uuid.nullable().parse(await call({ operation: "acquireLease" })); },
      async renewLease(candidate, token) { exact(candidate);
        return z.boolean().parse(await call({ operation: "renewLease", leaseToken: uuid.parse(token) })); },
      async releaseLease(candidate, token) { exact(candidate);
        await call({ operation: "releaseLease", leaseToken: uuid.parse(token) }); },
      async readSubmission(candidate, target) { exact(candidate);
        const result = submission.parse(await call({ operation: "readSubmission", job: job.parse(target) }));
        return result.receiptArtifactId === undefined ? { status: result.status }
          : { status: result.status, receiptArtifactId: result.receiptArtifactId }; },
      async beginSubmission(candidate, token, run, consentVersion, target) { exact(candidate, run);
        return uuid.nullable().parse(await call({ operation: "beginSubmission",
          leaseToken: uuid.parse(token), consentVersion, job: job.parse(target) })); },
      async markUncertain(candidate, token, target) { exact(candidate);
        await call({ operation: "markUncertain", leaseToken: uuid.parse(token), job: job.parse(target) }); },
      async confirmAfterVerification(candidate, token, target, receipt) { exact(candidate);
        return z.boolean().parse(await call({ operation: "confirmAfterVerification",
          leaseToken: uuid.parse(token), job: job.parse(target), receipt: {
            artifactId: uuid.parse(receipt.artifactId), sha256: receipt.sha256 } })); },
    },
    dispatch: {
      async read() { return dispatch.parse(await call({ operation: "readDispatch" })); },
      async markCompleted() { await call({ operation: "markDispatchCompleted" }); },
    },
    syntheticAudit: {
      async recordFinalClick(candidate, token, target) { exact(candidate);
        return z.boolean().parse(await call({ operation: "recordSyntheticFinalClick",
          leaseToken: uuid.parse(token), job: syntheticJob.parse(target) })); },
      async readClickAttempts(candidate, target) { exact(candidate);
        return z.number().int().nonnegative().parse(await call({ operation: "readSyntheticClickAttempts",
          job: syntheticJob.parse(target) })); },
    },
  };
}
