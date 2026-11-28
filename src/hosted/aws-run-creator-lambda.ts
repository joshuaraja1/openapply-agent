import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoTrustedRunCreator } from "../cloud/aws-run-creator-ports.js";
import { DynamoBillingStore } from "./stripe-billing-store.js";
import { createOidcSubjectVerifier } from "./checkout-http.js";
import { handleApplicationRunHttp } from "./application-run-http.js";
import { handleReviewedRetryHttp } from "./reviewed-retry-http.js";
import { DynamoHostedRunAdmission } from "../cloud/aws-enqueue-ports.js";
import { DynamoApplicationDispatchStore } from "../cloud/aws-durable-dispatch.js";
import { DynamoFargateLaunchStore } from "../cloud/fargate-launcher.js";
import { DurableApplicationJournal } from "../cloud/durable-journal.js";
import { verifyTaskTimeOfficialLead } from "../cloud/task-time-official-lead.js";
import type { OfficialLeadRow } from "../cloud/official-lead-sync.js";
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
  const runCreator = new DynamoTrustedRunCreator(db, s3,
    required("RUN_LEDGER_TABLE_NAME"), required("PRIVATE_ARTIFACT_BUCKET"));
  const ledgerTable = required("RUN_LEDGER_TABLE_NAME");
  const admission = new DynamoHostedRunAdmission(db, ledgerTable);
  const dispatch = new DynamoApplicationDispatchStore(db, ledgerTable);
  const launcher = new DynamoFargateLaunchStore(db, ledgerTable);
  const journal = new DurableApplicationJournal(db, ledgerTable);
  const createRun = (request: Request) => handleApplicationRunHttp(request, {
    appOrigin, issuer, verifySubject, ports: { billing,
      loadLead: (id: string) => runCreator.loadLead(id),
      loadProfile: (candidate: string, artifact: string) => runCreator.loadProfile(candidate, artifact),
      profileObjectExists: (candidate: string, artifact: string) => runCreator.profileObjectExists(candidate, artifact),
      createOrGet: (record: Parameters<typeof runCreator.createOrGet>[0],
        lead: Parameters<typeof runCreator.createOrGet>[1], now: number) => runCreator.createOrGet(record, lead, now),
    },
  });
  const retry = (request: Request) => handleReviewedRetryHttp(request, {
    appOrigin, issuer, verifySubject, ports: { billing,
      loadBlockedRun: (candidateId, runId) => admission.loadPreviewRun(candidateId, runId),
      readNeedsHumanPointer: (candidateId, runId) => dispatch.readNeedsHumanPointer(candidateId, runId),
      readSubmission: (candidateId, job) => journal.readSubmission(candidateId, job),
      hasCurrentConsent: (candidateId, runId) => admission.hasCurrentConsent(candidateId, runId),
      hasActiveTask: async candidateId => (await launcher.listCandidateTasks(candidateId))
        .some(row => row.state !== "stopped"),
      verifyLiveLead: async (leadId, job, now) => {
        const row = (await db.send(new GetCommand({ TableName: ledgerTable,
          Key: { pk: `LEAD#${leadId}`, sk: "VERIFIED" }, ConsistentRead: true }))).Item;
        if (!row) throw new Error("Official job changed");
        return verifyTaskTimeOfficialLead(row as OfficialLeadRow, job, now);
      },
      loadProfile: (candidateId, artifactId) => runCreator.loadProfile(candidateId, artifactId),
      profileObjectExists: (candidateId, artifactId) => runCreator.profileObjectExists(candidateId, artifactId),
      createOrGet: (record, lead, now) => runCreator.createOrGet(record, lead, now),
    },
  });
  return { handleRequest: (request: Request) => new URL(request.url).pathname ===
    "/api/applications/reviewed-retry" ? retry(request) : createRun(request),
    processReady: async () => ({ processed: 0, deferred: 0 }) };
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
