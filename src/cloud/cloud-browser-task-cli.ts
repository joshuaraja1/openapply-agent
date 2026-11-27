import { LambdaClient } from "@aws-sdk/client-lambda";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrowserSmoke } from "./browser-smoke-cli.js";
import { createAwsQueuedRunRuntime, type AwsQueuedRunConfiguration }
  from "./aws-queued-run-runtime.js";
import { SyntheticBrowserApplication, SyntheticReceiptVerifier }
  from "./synthetic-browser-application.js";
import { runSyntheticBrowserFixture } from "./synthetic-browser-fixture.js";

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
  if (mode !== "synthetic" || process.env.OPENAPPLY_CLOUD_SYNTHETIC_ONLY !== "1"
    || process.env.OPENAPPLY_ENABLE_CLOUD_QUEUE_TASK !== "1") {
    throw new Error("Cloud browser task mode is disabled");
  }
  const config = configuration();
  const region = required("AWS_REGION");
  const lambda = new LambdaClient({ region });
  try {
    const runtime = createAwsQueuedRunRuntime({ lambda }, config,
      { candidateId: required("OPENAPPLY_CANDIDATE_ID"),
        runId: required("OPENAPPLY_RUN_ID"),
        capability: required("OPENAPPLY_RUN_CAPABILITY") },
      new SyntheticBrowserApplication(), new SyntheticReceiptVerifier());
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
