import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { STSClient } from "@aws-sdk/client-sts";
import { ECSClient } from "@aws-sdk/client-ecs";
import { candidateIdForSubject } from "../cloud/hosted-run-creator.js";
import { CandidateVault } from "../cloud/candidate-vault.js";
import { KmsDataKeys, S3ArtifactStore } from "../cloud/aws-artifact-store.js";
import { DynamoOnboardingMarkers } from "./aws-onboarding-store.js";
import { DynamoCandidateDeletionStore } from "./aws-candidate-deletion-store.js";
import { AssumeRoleCandidatePurger } from "./aws-candidate-purger.js";
import { DynamoCandidatePlanStatus } from "./aws-plan-status.js";
import { handleCandidateOnboardingHttp } from "./candidate-onboarding-http.js";
import { handleCandidateDeletionHttp } from "./candidate-deletion-http.js";
import { retryCandidateDeletions } from "./candidate-deletion.js";
import { DynamoFargateLaunchStore, stopCandidateFargateTask } from "../cloud/fargate-launcher.js";
import { createOidcSubjectVerifier } from "./checkout-http.js";
import { handleHttpApiEvent, type HttpApiEvent } from "./aws-lambda-adapter.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function runtime() {
  if (required("ONBOARDING_ENABLED") !== "true") throw new Error("Onboarding disabled");
  const appOrigin = required("APP_ORIGIN");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid app origin");
  }
  const issuer = required("COGNITO_ISSUER");
  const verifySubject = createOidcSubjectVerifier({ issuer,
    audience: required("COGNITO_CLIENT_ID"), jwksUrl: required("COGNITO_JWKS_URL") });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const vault = new CandidateVault(new KmsDataKeys(new KMSClient({}), required("CANDIDATE_KMS_KEY_ARN")),
    new S3ArtifactStore(new S3Client({}), required("PRIVATE_ARTIFACT_BUCKET")));
  const markers = new DynamoOnboardingMarkers(db, required("RUN_LEDGER_TABLE_NAME"));
  const deletion = new DynamoCandidateDeletionStore(db, required("RUN_LEDGER_TABLE_NAME"));
  const plans = new DynamoCandidatePlanStatus(db, required("ENTITLEMENT_TABLE_NAME"));
  const candidateId = (subject: string) => candidateIdForSubject(issuer, subject);
  const deletionVault = process.env.CANDIDATE_DELETION_ENABLED === "true"
    ? new AssumeRoleCandidatePurger(new STSClient({}), required("CANDIDATE_PURGE_ROLE_ARN"),
      required("PRIVATE_ARTIFACT_BUCKET")) : vault;
  const stopCandidateTasks = process.env.FARGATE_DELETION_STOP_ENABLED === "true"
    ? (candidate: string) => stopCandidateFargateTask(candidate,
      { clusterArn: required("ECS_CLUSTER_ARN"), ledgerTable: required("RUN_LEDGER_TABLE_NAME") },
      { store: new DynamoFargateLaunchStore(db, required("RUN_LEDGER_TABLE_NAME")),
        ecs: new ECSClient({}) })
    : undefined;
  const deletionDeps = { appOrigin, verifySubject, store: deletion, vault: deletionVault,
    candidateIdForSubject: candidateId,
    ...(stopCandidateTasks ? { stopCandidateTasks } : {}) };
  return { handleRequest: async (request: Request) => ["/api/candidates/delete",
    "/api/candidates/deletion-status"].includes(new URL(request.url).pathname)
    ? process.env.CANDIDATE_DELETION_ENABLED === "true"
      ? handleCandidateDeletionHttp(request, deletionDeps)
      : new Response("", { status: 404, headers: { "cache-control": "no-store" } })
    : handleCandidateOnboardingHttp(request, {
    appOrigin, verifySubject, vault, markers,
    loadEntitlements: (subject: string) => plans.loadEntitlements(subject),
    candidateIdForSubject: candidateId,
  }), processReady: async () => ({ processed: 0, deferred: 0 }),
    retryDeletions: () => retryCandidateDeletions(deletionDeps) };
}

/** Only the dedicated EventBridge rule can invoke this entry point. */
export async function retryHandler(event: { source?: string; "detail-type"?: string }) {
  if (process.env.CANDIDATE_DELETION_ENABLED !== "true"
    || event.source !== "aws.events" || event["detail-type"] !== "Scheduled Event") {
    throw new Error("Deletion retry is disabled or event is invalid");
  }
  cached ??= runtime();
  const result = await cached.retryDeletions();
  if (result.malformed) console.error(`Deletion retry deferred ${result.malformed} invalid index rows`);
  return result;
}

let cached: ReturnType<typeof runtime> | undefined;
/** Dedicated IAM role; no Stripe secrets, queue send, or browser execution. */
export async function handler(event: HttpApiEvent) {
  try {
    cached ??= runtime();
    return await handleHttpApiEvent(event, cached, required("APP_ORIGIN"));
  } catch {
    return { statusCode: 503, headers: { "cache-control": "no-store" },
      body: "", isBase64Encoded: true as const };
  }
}

/** Dedicated API integration; cannot serve onboarding or plan requests. */
export async function deletionHandler(event: HttpApiEvent) {
  if (process.env.CANDIDATE_DELETION_ENABLED !== "true"
    || !["/api/candidates/delete", "/api/candidates/deletion-status"].includes(event.rawPath)) {
    return { statusCode: 404, headers: { "cache-control": "no-store" },
      body: "", isBase64Encoded: true as const };
  }
  return handler(event);
}
