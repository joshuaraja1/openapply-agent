import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { KmsDataKeys, S3ArtifactStore } from "./aws-artifact-store.js";
import { requestScopedArtifactCredentials } from "./aws-artifact-broker-client.js";
import { createBrokeredRunState } from "./aws-run-state-broker-client.js";
import { CandidateVault } from "./candidate-vault.js";
import { runCloudPreSubmitPreview } from "./cloud-preview-runtime.js";
import { runHostedPreSubmitPreview } from "./hosted-pre-submit-preview.js";
import { renderLocalJakePdf } from "../resume/local-tectonic.js";

export interface AwsPreviewConfiguration {
  region: string; bucket: string; kmsKeyArn: string; brokerArn: string;
  tectonicBinary: string; tectonicCache: string; privateRoot: string;
}

/** Browser tasks use only the named Lambda broker. Temporary S3/KMS access is
 * minted after the exact run lease and scoped to one job seeker. */
export async function runAwsCloudPreSubmitPreview(config: AwsPreviewConfiguration,
  scope: { candidateId: string; runId: string; capability: string }): Promise<string> {
  if (!/^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:key\//.test(config.kmsKeyArn)
    || !config.kmsKeyArn.includes(`:${config.region}:`)
    || !config.bucket || !config.privateRoot.startsWith("/")) {
    throw new Error("Cloud preview configuration is incomplete");
  }
  const lambda = new LambdaClient({ region: config.region });
  const state = createBrokeredRunState(lambda, config.brokerArn, scope.capability, scope);
  const root = await mkdtemp(join(config.privateRoot, "preview-"));
  try {
    const outcome = await runCloudPreSubmitPreview(scope,
      { work: root, browser: join(root, "browser") }, {
        ...state,
        vault: { async restoreToPrivateTemp(candidateId, runId, leaseToken, artifactId) {
          if (candidateId !== scope.candidateId || runId !== scope.runId) {
            throw new Error("Cloud preview vault scope mismatch");
          }
          const grant = await requestScopedArtifactCredentials(lambda, config.brokerArn,
            scope.capability, { candidateId, runId, leaseToken });
          const credentials = { accessKeyId: grant.accessKeyId,
            secretAccessKey: grant.secretAccessKey, sessionToken: grant.sessionToken };
          return new CandidateVault(
            new KmsDataKeys(new KMSClient({ region: config.region, credentials }), config.kmsKeyArn),
            new S3ArtifactStore(new S3Client({ region: config.region, credentials }), config.bucket))
            .restoreToPrivateTemp(candidateId, artifactId);
        } },
      }, input => runHostedPreSubmitPreview(input, {
        async renderResume(source, job, candidate, directory) {
          const pdf = await renderLocalJakePdf(source, job, candidate, directory,
            { binary: config.tectonicBinary, cacheDirectory: config.tectonicCache });
          return pdf.path;
        },
      }));
    // Only a bounded status is emitted. Candidate facts, page text, and URLs
    // never enter the task log. A durable handoff record is still required.
    return outcome.status;
  } finally {
    await rm(root, { recursive: true, force: true });
    lambda.destroy();
  }
}
