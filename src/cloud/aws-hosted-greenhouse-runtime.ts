import { LambdaClient } from "@aws-sdk/client-lambda";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { requireHostedAccess } from "../hosted/entitlement.js";
import { renderLocalJakePdf } from "../resume/local-tectonic.js";
import { createAwsQueuedRunRuntime, type AwsQueuedRunConfiguration } from "./aws-queued-run-runtime.js";
import { createBrokeredRunState } from "./aws-run-state-broker-client.js";
import { assertGreenhouseLead, GreenhouseReceiptVerifier,
  prepareHostedGreenhouseApplication } from "./hosted-greenhouse-application.js";
import { officialJobKey } from "./durable-journal.js";

export interface AwsGreenhouseConfiguration extends AwsQueuedRunConfiguration {
  region: string; tectonicBinary: string; tectonicCache: string; privateRoot: string;
}

/** Explicitly staged only. The deployed Fargate task definition remains preview-only. */
export async function runAwsHostedGreenhouseApplication(config: AwsGreenhouseConfiguration,
  scope: { candidateId: string; runId: string; capability: string }): Promise<string> {
  if (!config.region || !config.privateRoot.startsWith("/") || !config.tectonicBinary
    || !config.tectonicCache || !config.artifactBucket || !config.artifactBrokerArn
    || !config.artifactKmsKeyArn.includes(`:${config.region}:`)) {
    throw new Error("Hosted Greenhouse runtime configuration is incomplete");
  }
  const lambda = new LambdaClient({ region: config.region });
  const state = createBrokeredRunState(lambda, config.artifactBrokerArn,
    scope.capability, scope);
  const root = await mkdtemp(join(config.privateRoot, "greenhouse-"));
  const runtime = createAwsQueuedRunRuntime({ lambda }, config, scope, {
    async prepare(profilePath, job, candidateId, context) {
      if (!context || candidateId !== scope.candidateId || context.runId !== scope.runId) {
        throw new Error("Greenhouse browser task scope mismatch");
      }
      const binding = await state.preview.loadBinding(context.leaseToken);
      assertGreenhouseLead(binding.lead, job);
      if (officialJobKey(binding.lead.job) !== officialJobKey(job)) {
        throw new Error("Greenhouse posting changed after dispatch");
      }
      return prepareHostedGreenhouseApplication({ candidateId, runJob: job,
        lead: binding.lead, profilePath, privateWorkDirectory: root,
        privateBrowserDirectory: join(root, "browser") }, {
        async renderResume(source, discovered, candidate, directory) {
          const pdf = await renderLocalJakePdf(source, discovered, candidate, directory,
            { binary: config.tectonicBinary, cacheDirectory: config.tectonicCache });
          return pdf.path;
        },
        async beforeClick() {
          try {
            if (!await state.journal.renewLease(candidateId, context.leaseToken)
              || !await state.authorization.hasCurrentConsent(candidateId, scope.runId)) return false;
            const record = await state.runRecords.loadIdentity(candidateId, scope.runId);
            if (officialJobKey(record.job) !== officialJobKey(job)) return false;
            requireHostedAccess(record.subjectId, await state.billing.loadEntitlements(record.subjectId));
            return true;
          } catch { return false; }
        },
      });
    },
  }, new GreenhouseReceiptVerifier());
  try { return await runtime.runExact(); }
  finally {
    await rm(root, { recursive: true, force: true });
    lambda.destroy();
  }
}
