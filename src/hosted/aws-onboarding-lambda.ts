import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { candidateIdForSubject } from "../cloud/hosted-run-creator.js";
import { CandidateVault } from "../cloud/candidate-vault.js";
import { KmsDataKeys, S3ArtifactStore } from "../cloud/aws-artifact-store.js";
import { DynamoOnboardingMarkers } from "./aws-onboarding-store.js";
import { DynamoCandidateDeletionStore } from "./aws-candidate-deletion-store.js";
import { DynamoCandidatePlanStatus } from "./aws-plan-status.js";
import { handleCandidateOnboardingHttp } from "./candidate-onboarding-http.js";
import { handleCandidateDeletionHttp } from "./candidate-deletion-http.js";
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
  return { handleRequest: async (request: Request) => new URL(request.url).pathname === "/api/candidates/delete"
    ? process.env.CANDIDATE_DELETION_ENABLED === "true"
      ? handleCandidateDeletionHttp(request, { appOrigin, verifySubject, store: deletion, vault,
        candidateIdForSubject: candidateId })
      : new Response("", { status: 404, headers: { "cache-control": "no-store" } })
    : handleCandidateOnboardingHttp(request, {
    appOrigin, verifySubject, vault, markers,
    loadEntitlements: (subject: string) => plans.loadEntitlements(subject),
    candidateIdForSubject: candidateId,
  }), processReady: async () => ({ processed: 0, deferred: 0 }) };
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
