import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoTrustedRunCreator } from "../cloud/aws-run-creator-ports.js";
import { CandidateVault } from "../cloud/candidate-vault.js";
import { KmsDataKeys, S3ArtifactStore } from "../cloud/aws-artifact-store.js";
import { DynamoBillingStore } from "./stripe-billing-store.js";
import { createOidcSubjectVerifier } from "./checkout-http.js";
import { handleApplicationRunHttp } from "./application-run-http.js";
import { handleHttpApiEvent, type HttpApiEvent } from "./aws-lambda-adapter.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

function runtime() {
  if (required("RUN_CREATION_ENABLED") !== "true") throw new Error("Run creation disabled");
  const appOrigin = required("APP_ORIGIN");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid app origin");
  }
  const issuer = required("COGNITO_ISSUER");
  const verifySubject = createOidcSubjectVerifier({ issuer,
    audience: required("COGNITO_CLIENT_ID"), jwksUrl: required("COGNITO_JWKS_URL") });
  const billing = new DynamoBillingStore(db, required("BILLING_TABLE_NAME"),
    required("ENTITLEMENT_TABLE_NAME"));
  const bucket = required("PRIVATE_ARTIFACT_BUCKET");
  const vault = new CandidateVault(new KmsDataKeys(new KMSClient({}),
    required("CANDIDATE_KMS_KEY_ARN")), new S3ArtifactStore(s3, bucket));
  const runCreator = new DynamoTrustedRunCreator(db, s3, vault,
    required("RUN_LEDGER_TABLE_NAME"), bucket);
  return { handleRequest: (request: Request) => handleApplicationRunHttp(request, {
    appOrigin, issuer, verifySubject, ports: { billing,
      loadLead: (id: string) => runCreator.loadLead(id),
      loadProfile: (candidate: string, artifact: string) => runCreator.loadProfile(candidate, artifact),
      profileArtifactsAvailable: (candidate: string, artifact: string) =>
        runCreator.profileArtifactsAvailable(candidate, artifact),
      createOrGet: (record: Parameters<typeof runCreator.createOrGet>[0],
        lead: Parameters<typeof runCreator.createOrGet>[1], now: number) => runCreator.createOrGet(record, lead, now),
    },
  }), processReady: async () => ({ processed: 0, deferred: 0 }) };
}

let cached: ReturnType<typeof runtime> | undefined;
/** Separate Lambda role never receives Stripe keys or browser execution IAM. */
export async function handler(event: HttpApiEvent) {
  try {
    cached ??= runtime();
    return await handleHttpApiEvent(event, cached, required("APP_ORIGIN"));
  } catch {
    return { statusCode: 503, headers: { "cache-control": "no-store" },
      body: "", isBase64Encoded: true as const };
  }
}
