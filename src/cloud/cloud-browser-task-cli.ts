import { LambdaClient } from "@aws-sdk/client-lambda";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowserSmoke } from "./browser-smoke-cli.js";
import { createAwsQueuedRunRuntime, type AwsQueuedRunConfiguration }
  from "./aws-queued-run-runtime.js";
import { SyntheticBrowserApplication, SyntheticReceiptVerifier }
  from "./synthetic-browser-application.js";
import { runSyntheticBrowserFixture } from "./synthetic-browser-fixture.js";
import { createBrokeredRunState } from "./aws-run-state-broker-client.js";
import { syntheticCheckpoint, syntheticCrashStage } from "./synthetic-fault-probe.js";
import { runAwsCloudPreSubmitPreview } from "./aws-cloud-preview-runtime.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Cloud task configuration ${name} is required`);
  return value;
}

function configuration(): AwsQueuedRunConfiguration {
  return {
    artifactBucket: required("OPENAPPLY_ARTIFACT_BUCKET"),
    artifactKmsKeyArn: required("OPENAPPLY_ARTIFACT_KMS_KEY_ARN"),
    artifactBrokerArn: required("OPENAPPLY_ARTIFACT_BROKER_ARN"),
  };
}

/** Docker defaults to the safe image smoke. An explicitly enabled task accepts
 * only the intercepted synthetic fixture; there is no real-site mode here. */
export async function runCloudBrowserTask(): Promise<"smoke" | string> {
  const mode = process.env.OPENAPPLY_CLOUD_TASK_MODE ?? "smoke";
  if (mode === "smoke") { await runBrowserSmoke(); return "smoke"; }
  if (mode === "fixture") { await runSyntheticBrowserFixture(); return "fixture"; }
  if (mode === "preview") {
    if (process.env.OPENAPPLY_CLOUD_PREVIEW_ONLY !== "1"
      || process.env.OPENAPPLY_SUBMISSION_MODE !== "disabled") {
      throw new Error("Cloud browser preview mode is disabled");
    }
    return runAwsCloudPreSubmitPreview({
      region: required("AWS_REGION"),
      bucket: required("OPENAPPLY_ARTIFACT_BUCKET"),
      kmsKeyArn: required("OPENAPPLY_ARTIFACT_KMS_KEY_ARN"),
      brokerArn: required("OPENAPPLY_ARTIFACT_BROKER_ARN"),
      tectonicBinary: required("OPENAPPLY_TECTONIC_BIN"),
      tectonicCache: required("OPENAPPLY_TECTONIC_CACHE"),
      privateRoot: required("OPENAPPLY_PRIVATE_WORK_ROOT"),
    }, { candidateId: required("OPENAPPLY_CANDIDATE_ID"),
      runId: required("OPENAPPLY_RUN_ID"), capability: required("OPENAPPLY_RUN_CAPABILITY") });
  }
  if (mode !== "synthetic" || process.env.OPENAPPLY_CLOUD_SYNTHETIC_ONLY !== "1"
    || process.env.OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK !== "1"
    || process.env.OPENAPPLY_SUBMISSION_MODE !== "disabled") {
    throw new Error("Cloud browser task mode is disabled");
  }
  syntheticCrashStage(); // Validate the one-off task definition before any AWS call.
  const config = configuration();
  const region = required("AWS_REGION");
  const scope = { candidateId: required("OPENAPPLY_CANDIDATE_ID"),
    runId: required("OPENAPPLY_RUN_ID"), capability: required("OPENAPPLY_RUN_CAPABILITY") };
  const lambda = new LambdaClient({ region });
  try {
    const audit = createBrokeredRunState(lambda, config.artifactBrokerArn, scope.capability, scope)
      .syntheticAudit;
    const runtime = createAwsQueuedRunRuntime({ lambda }, config, scope,
      new SyntheticBrowserApplication({
        async recordFinalClick(candidateId, runId, leaseToken, job) {
          if (runId !== scope.runId) throw new Error("Synthetic audit run scope mismatch");
          return audit.recordFinalClick(candidateId, leaseToken, job);
        },
        afterFinalClick(job) { syntheticCheckpoint("after_click", job); },
      }), new SyntheticReceiptVerifier(),
      { checkpoint(stage, job) { syntheticCheckpoint(stage, job); } });
    const outcome = await runtime.runExact();
    process.stdout.write(`Cloud synthetic queue task outcome: ${outcome}\n`);
    return outcome;
  } finally {
    lambda.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCloudBrowserTask().catch((error: unknown) => {
    process.stderr.write(`Cloud browser task failed: ${error instanceof Error ? error.name : "unknown"}\n`);
    process.exitCode = 1;
  });
}
