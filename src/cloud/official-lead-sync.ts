import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { officialSourceForLead } from "../browser/verify-official.js";
import { sourceUrl, type JobSource } from "../config.js";
import { fetchSource } from "../sources/fetch.js";
import type { NormalizedJob } from "../types.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i);
const company = z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const sourceConfig = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("greenhouse"), boardToken: slug, company }),
  z.strictObject({ provider: z.literal("ashby"), boardName: slug, company }),
  z.strictObject({ provider: z.literal("lever"), site: slug,
    region: z.enum(["global", "eu"]).default("global"), company }),
  z.strictObject({ provider: z.literal("smartrecruiters"), companyIdentifier: slug, company }),
]);
export const officialLeadSyncConfigSchema = z.strictObject({
  version: z.literal(1), sources: z.array(sourceConfig).min(1).max(20),
  maxJobsPerSource: z.number().int().min(1).max(500).default(250),
});
export type OfficialLeadSource = z.infer<typeof sourceConfig>;
export type OfficialLeadSyncConfig = z.infer<typeof officialLeadSyncConfigSchema>;

const memberSchema = z.object({ pk: z.string(), sk: z.string(),
  leadId: z.uuid(), jobKey: z.string().regex(/^JOB#[a-f0-9]{64}$/),
  verifiedAtEpoch: z.number().int().nonnegative() });
export type LeadMember = z.infer<typeof memberSchema>;

export interface OfficialLeadRow {
  pk: string; sk: "VERIFIED"; status: "open"; leadId: string;
  job: OfficialJobIdentity; jobKey: string; canonicalUrl: string;
  expiresAt: number; sourceKey: string; verifiedAt: string;
  verifiedAtEpoch: number;
  provenance: {
    kind: "official-ats-api"; provider: OfficialLeadSource["provider"];
    sourceUrl: string; title: string; company: string; location: string | null;
    descriptionText: string; sourcePublishedAt: string | null;
  };
}

const supportedHosts: Record<OfficialLeadSource["provider"], readonly string[]> = {
  greenhouse: ["boards-api.greenhouse.io"], ashby: ["api.ashbyhq.com"],
  lever: ["api.lever.co", "api.eu.lever.co"],
  smartrecruiters: ["api.smartrecruiters.com"],
};
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LEAD_TTL_SECONDS = 15 * 60;

function identifier(source: OfficialLeadSource): string {
  switch (source.provider) {
    case "greenhouse": return source.boardToken;
    case "ashby": return source.boardName;
    case "lever": return source.site;
    case "smartrecruiters": return source.companyIdentifier;
  }
}

function uuidFromJobKey(jobKey: string): string {
  const bytes = createHash("sha256").update(`openapply:official-lead:${jobKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sourceKey(source: OfficialLeadSource): string {
  const digest = createHash("sha256").update(JSON.stringify([
    source.provider, identifier(source).toLowerCase(), source.provider === "lever" ? source.region : "",
  ])).digest("hex");
  return `SOURCE#${digest}`;
}

/** Only the four fixed official API hosts are fetched. Redirects are refused,
 * and response bytes are bounded before a provider parser sees them. */
export function officialSourceRequest(source: OfficialLeadSource,
  network: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (!(typeof input === "string" || input instanceof URL)) {
      throw new Error("Official source request must be a fixed URL");
    }
    const url = new URL(String(input));
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !supportedHosts[source.provider].includes(url.hostname)) {
      throw new Error("Official source request left its provider API");
    }
    const signal = AbortSignal.timeout(15_000);
    const response = await network(url, { ...init, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Official source redirected");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Official source response exceeded size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Official source response has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("Official source response exceeded size limit");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}

function postingUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error("Employer application URL is not an exact HTTPS posting");
  }
  return url;
}

/** Reconcile a provider API row against the source identifier and its public
 * employer application URL. Browser/board text cannot create a VERIFIED row. */
export function verifiedOfficialLead(source: OfficialLeadSource, posting: NormalizedJob,
  at = new Date()): OfficialLeadRow {
  const employerId = identifier(source);
  const prefix = `${source.provider}:${employerId}:`;
  if (posting.provider !== source.provider || !posting.id.startsWith(prefix)) {
    throw new Error("Official posting identity differs from its configured source");
  }
  const requisitionId = posting.id.slice(prefix.length);
  if (!/^[a-z0-9_-]{1,128}$/i.test(requisitionId) || !posting.descriptionText.trim()
    || posting.descriptionText.length > 100_000 || posting.title.length > 300
    || posting.company.length > 300) {
    throw new Error("Official posting lacks a stable requisition or description");
  }
  const url = postingUrl(posting.applicationUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (["apply", "application"].includes(parts.at(-1)?.toLowerCase() ?? "")) {
    parts.pop();
  }
  const base = new URL(url.href);
  base.pathname = `/${parts.join("/")}`;
  const official = officialSourceForLead(base.href);
  if (!official || official.source.provider !== source.provider
    || official.postingId.toLowerCase() !== requisitionId.toLowerCase()
    || (source.provider === "greenhouse" && official.source.provider === "greenhouse"
      && official.source.boardToken.toLowerCase() !== employerId.toLowerCase())
    || (source.provider === "ashby" && official.source.provider === "ashby"
      && official.source.boardName.toLowerCase() !== employerId.toLowerCase())
    || (source.provider === "lever" && official.source.provider === "lever"
      && (official.source.site.toLowerCase() !== employerId.toLowerCase()
        || official.source.region !== source.region))
    || (source.provider === "smartrecruiters" && official.source.provider === "smartrecruiters"
      && official.source.companyIdentifier.toLowerCase() !== employerId.toLowerCase())) {
    throw new Error("Employer application URL does not identify the official posting");
  }
  const job: OfficialJobIdentity = { provider: source.provider,
    employerId: employerId.toLowerCase(), requisitionId: requisitionId.toLowerCase() };
  const jobKey = officialJobKey(job);
  const leadId = uuidFromJobKey(jobKey);
  const epoch = Math.floor(at.getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid verification time");
  url.search = "";
  return { pk: `LEAD#${leadId}`, sk: "VERIFIED", status: "open", leadId,
    job, jobKey, canonicalUrl: url.href, expiresAt: epoch + LEAD_TTL_SECONDS,
    sourceKey: sourceKey(source), verifiedAt: at.toISOString(), verifiedAtEpoch: at.getTime(),
    provenance: { kind: "official-ats-api", provider: source.provider,
      sourceUrl: sourceUrl({ ...source, enabled: true, allowedApplicationHosts: [] } as JobSource),
      title: posting.title, company: posting.company, location: posting.location,
      descriptionText: posting.descriptionText,
      sourcePublishedAt: posting.sourcePublishedAt },
  };
}

export interface OfficialLeadStore {
  upsert(row: OfficialLeadRow): Promise<void>;
  members(source: OfficialLeadSource, max: number): Promise<LeadMember[]>;
  closeMissing(member: LeadMember, syncEpoch: number, nowEpoch: number): Promise<void>;
}

/** A failed or truncated source never closes prior leads: the 15-minute expiry
 * is the fail-closed bound while operators repair that source. */
export async function syncOfficialLeads(configValue: unknown, store: OfficialLeadStore,
  dependencies: { fetchJobs?: (source: JobSource, now: Date, max: number,
    request: typeof fetch) => Promise<NormalizedJob[]>; network?: typeof fetch; now?: Date } = {}) {
  const config = officialLeadSyncConfigSchema.parse(configValue);
  const now = dependencies.now ?? new Date();
  const results: { provider: string; accepted: number; closed: number; failed: boolean }[] = [];
  for (const source of config.sources) {
    let accepted = 0;
    let closed = 0;
    try {
      const jobSource = { ...source, enabled: true, allowedApplicationHosts: [] } as JobSource;
      const postings = await (dependencies.fetchJobs ?? fetchSource)(jobSource, now,
        config.maxJobsPerSource, officialSourceRequest(source, dependencies.network));
      if (postings.length > config.maxJobsPerSource) throw new Error("Official source was truncated");
      const rows = postings.map(posting => verifiedOfficialLead(source, posting, now));
      const current = new Set<string>();
      for (const row of rows) {
        if (current.has(row.leadId)) throw new Error("Official source repeated a requisition");
        current.add(row.leadId);
      }
      // Snapshot the previous membership before writes: at capacity, replacing
      // one posting temporarily creates max + 1 members until closure.
      const previous = await store.members(source, config.maxJobsPerSource);
      for (const row of rows) { await store.upsert(row); accepted++; }
      for (const member of previous) {
        if (!current.has(member.leadId)) {
          await store.closeMissing(member, now.getTime(), Math.floor(now.getTime() / 1000));
          closed++;
        }
      }
      results.push({ provider: source.provider, accepted, closed, failed: false });
    } catch {
      results.push({ provider: source.provider, accepted, closed, failed: true });
    }
  }
  return results;
}

/** Only this trusted sync role may write global, candidate-free lead metadata. */
export class DynamoOfficialLeadStore implements OfficialLeadStore {
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string) {
    if (!table.trim()) throw new Error("Run ledger table required");
  }

  async upsert(row: OfficialLeadRow): Promise<void> {
    const member = { pk: row.sourceKey, sk: `LEAD#${row.leadId}`,
      leadId: row.leadId, jobKey: row.jobKey, verifiedAtEpoch: row.verifiedAtEpoch,
      expiresAt: row.expiresAt };
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.table, Item: row,
        ConditionExpression: "attribute_not_exists(pk) OR (jobKey = :job AND sourceKey = :source AND verifiedAtEpoch <= :time AND (attribute_not_exists(closedAtEpoch) OR closedAtEpoch < :time))",
        ExpressionAttributeValues: { ":job": row.jobKey, ":source": row.sourceKey,
          ":time": row.verifiedAtEpoch } } },
      { Put: { TableName: this.table, Item: member,
        ConditionExpression: "attribute_not_exists(pk) OR (jobKey = :job AND verifiedAtEpoch <= :time)",
        ExpressionAttributeValues: { ":job": row.jobKey, ":time": row.verifiedAtEpoch } } },
    ] }));
  }

  async members(source: OfficialLeadSource, max: number): Promise<LeadMember[]> {
    const key = sourceKey(source);
    // A terminated refresh may leave its new rows beside the old set. Allow
    // one prior maximum-size set so the next complete refresh can reconcile it.
    const maxPrevious = max + 500;
    const found: LeadMember[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.db.send(new QueryCommand({ TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :lead)",
        ExpressionAttributeValues: { ":pk": key, ":lead": "LEAD#" },
        ConsistentRead: true, Limit: maxPrevious + 1,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of result.Items ?? []) {
        const row = memberSchema.parse(item);
        if (row.pk !== key || row.sk !== `LEAD#${row.leadId}`) throw new Error("Invalid source member");
        found.push(row);
        if (found.length > maxPrevious) throw new Error("Official source membership exceeded bound");
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return found;
  }

  async closeMissing(member: LeadMember, syncEpoch: number, nowEpoch: number): Promise<void> {
    const key = { pk: `LEAD#${member.leadId}`, sk: "VERIFIED" };
    const lead = await this.db.send(new GetCommand({ TableName: this.table,
      Key: key, ConsistentRead: true }));
    if (!lead.Item) {
      await this.db.send(new TransactWriteCommand({ TransactItems: [{ Delete: {
        TableName: this.table, Key: { pk: member.pk, sk: member.sk },
        ConditionExpression: "jobKey = :job AND verifiedAtEpoch < :time",
        ExpressionAttributeValues: { ":job": member.jobKey, ":time": syncEpoch },
      } }] }));
      return;
    }
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.table, Key: key,
        UpdateExpression: "SET #status = :closed, expiresAt = :expires, verifiedAtEpoch = :time, closedAtEpoch = :time",
        ConditionExpression: "jobKey = :job AND sourceKey = :source AND verifiedAtEpoch < :time",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "closed", ":expires": nowEpoch,
          ":time": syncEpoch, ":job": member.jobKey, ":source": member.pk } } },
      { Delete: { TableName: this.table, Key: { pk: member.pk, sk: member.sk },
        ConditionExpression: "jobKey = :job AND verifiedAtEpoch < :time",
        ExpressionAttributeValues: { ":job": member.jobKey, ":time": syncEpoch } } },
    ] }));
  }
}
