import { z } from "zod";
import type { OfficialLeadRow } from "../cloud/official-lead-sync.js";
import { officialJobKey } from "../cloud/durable-journal.js";
import { officialSourceForLead } from "../browser/verify-official.js";
import type { VerifySubject } from "./checkout-http.js";

const uuid = z.uuid();
const profileSchema = z.object({ version: z.literal(1),
  provenance: z.literal("candidate-entered-and-reviewed"), candidateId: uuid,
  targetRoles: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  locations: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  consent: z.object({ reviewed: z.literal(true), storage: z.literal(true), automation: z.literal(true) }),
});

export interface JobDiscoveryPorts {
  loadReviewedProfile(candidateId: string, subjectId: string): Promise<Uint8Array | undefined>;
  loadOfficialLeads(): Promise<OfficialLeadRow[]>;
}
export interface JobDiscoveryDeps {
  appOrigin: string;
  issuer: string;
  verifySubject: VerifySubject;
  ports: JobDiscoveryPorts;
  candidateIdForSubject(issuer: string, subjectId: string): string;
  now?: () => Date;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'",
  } });
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
}
function locationMatches(targets: string[], location: string | null): boolean {
  if (!location) return false;
  const actual = normalize(location);
  return targets.some(target => {
    const wanted = normalize(target);
    return Boolean(wanted) && (wanted === "anywhere" || wanted === "any location"
      || (wanted === "remote" ? actual.includes("remote") : actual.includes(wanted)));
  });
}
function roleMatches(targets: string[], title: string): boolean {
  const actual = normalize(title);
  return targets.some(target => {
    const wanted = normalize(target);
    return Boolean(wanted) && actual.includes(wanted);
  });
}

function sourceEmployerId(source: NonNullable<ReturnType<typeof officialSourceForLead>>["source"]): string {
  switch (source.provider) {
    case "greenhouse": return source.boardToken;
    case "ashby": return source.boardName;
    case "lever": return source.site;
    case "smartrecruiters": return source.companyIdentifier;
    default: return "";
  }
}

export function matchedOfficialJobs(leads: OfficialLeadRow[], profileBytes: Uint8Array,
  candidateId: string, now = new Date(), page = 0) {
  const profile = profileSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(profileBytes)));
  if (profile.candidateId !== candidateId) throw new Error("Profile identity mismatch");
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const matches = leads.filter(lead => {
    if (lead.pk !== `LEAD#${lead.leadId}` || lead.sk !== "VERIFIED" || lead.status !== "open"
      || !Number.isSafeInteger(lead.expiresAt) || lead.expiresAt <= nowEpoch
      || !Number.isSafeInteger(lead.verifiedAtEpoch) || lead.verifiedAtEpoch > now.getTime()
      || lead.jobKey !== officialJobKey(lead.job)
      || lead.provenance.kind !== "official-ats-api"
      || lead.provenance.provider !== lead.job.provider
      || !roleMatches(profile.targetRoles, lead.provenance.title)
      || !locationMatches(profile.locations, lead.provenance.location)) return false;
    try {
      const postingUrl = new URL(lead.canonicalUrl);
      const path = postingUrl.pathname.split("/").filter(Boolean);
      const final = path.at(-1)?.toLowerCase();
      if (final === (lead.job.provider === "ashby" ? "application" : "apply")) {
        path.pop();
        postingUrl.pathname = `/${path.join("/")}`;
      }
      const official = officialSourceForLead(postingUrl.href);
      return Boolean(official && official.source.provider === lead.job.provider
        && sourceEmployerId(official.source).toLowerCase() === lead.job.employerId.toLowerCase()
        && official.postingId.toLowerCase() === lead.job.requisitionId.toLowerCase());
    } catch { return false; }
  }).sort((a, b) => {
    const effectiveTime = (lead: OfficialLeadRow) => {
      const published = Date.parse(lead.provenance.sourcePublishedAt ?? "");
      return Number.isFinite(published) ? published : lead.verifiedAtEpoch;
    };
    return effectiveTime(b) - effectiveTime(a) || a.leadId.localeCompare(b.leadId);
  });
  const start = page * 10;
  return { jobs: matches.slice(start, start + 10).map(lead => ({
    leadId: lead.leadId, title: lead.provenance.title, company: lead.provenance.company,
    location: lead.provenance.location, provider: lead.provenance.provider,
    officialUrl: lead.canonicalUrl, sourcePublishedAt: lead.provenance.sourcePublishedAt,
    verifiedAt: lead.verifiedAt,
  })), nextPage: start + 10 < matches.length && page < 9 ? page + 1 : null };
}

export async function handleJobDiscoveryHttp(request: Request, deps: JobDiscoveryDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/jobs/matches") return json(404, { error: "Not found" });
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.appOrigin) return json(403, { error: "Origin not allowed" });
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return json(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return json(401, { error: "Authentication required" }); }
  if ([...url.searchParams.keys()].some(key => key !== "page")
    || url.searchParams.getAll("page").length > 1
    || !/^(?:[0-9])$/.test(url.searchParams.get("page") ?? "0")) {
    return json(400, { error: "Invalid page" });
  }
  const candidateId = deps.candidateIdForSubject(deps.issuer, subjectId);
  try {
    const profile = await deps.ports.loadReviewedProfile(candidateId, subjectId);
    if (!profile) return json(403, { error: "Reviewed profile required" });
    try {
      return json(200, matchedOfficialJobs(await deps.ports.loadOfficialLeads(), profile,
        candidateId, deps.now?.() ?? new Date(), Number(url.searchParams.get("page") ?? 0)));
    } finally { profile.fill(0); }
  } catch { return json(503, { error: "Job matches temporarily unavailable" }); }
}
