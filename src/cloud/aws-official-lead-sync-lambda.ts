import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoOfficialLeadStore, syncOfficialLeads } from "./official-lead-sync.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Operator-configured official feed sync. The event contains no sources,
 * candidate IDs, URLs, or credentials; browser input cannot call this path. */
export async function handler(event: unknown) {
  if (required("OFFICIAL_LEAD_SYNC_ENABLED") !== "true") {
    throw new Error("Official lead sync disabled");
  }
  const scheduled = typeof event === "object" && event !== null
    && (event as { source?: unknown }).source === "aws.events"
    && (event as { "detail-type"?: unknown })["detail-type"] === "Scheduled Event";
  const manual = typeof event === "object" && event !== null
    && (event as { mode?: unknown }).mode === "operator-sync"
    && Object.keys(event).length === 1;
  if (!scheduled && !manual) throw new Error("Unsupported official lead sync event");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await syncOfficialLeads(JSON.parse(required("OFFICIAL_SOURCES_JSON")),
    new DynamoOfficialLeadStore(db, required("RUN_LEDGER_TABLE_NAME")));
  // Aggregates only: source identifiers, job text, and candidate data never enter logs.
  console.log(JSON.stringify({ event: "official_lead_sync", sources: result.length,
    accepted: result.reduce((sum, row) => sum + row.accepted, 0),
    closed: result.reduce((sum, row) => sum + row.closed, 0),
    failed: result.filter(row => row.failed).length }));
  return { sources: result.length, accepted: result.reduce((sum, row) => sum + row.accepted, 0),
    closed: result.reduce((sum, row) => sum + row.closed, 0),
    failed: result.filter(row => row.failed).length };
}
