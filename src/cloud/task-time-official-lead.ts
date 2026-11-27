import { officialSourceForLead } from "../browser/verify-official.js";
import type { JobSource } from "../config.js";
import { fetchSource } from "../sources/fetch.js";
import type { NormalizedJob } from "../types.js";
import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";
import { officialSourceRequest, verifiedOfficialLead,
  type OfficialLeadRow, type OfficialLeadSource } from "./official-lead-sync.js";

export type OfficialPostingFetcher = (source: OfficialLeadSource,
  now: Date) => Promise<NormalizedJob[]>;

async function fetchLivePostings(source: OfficialLeadSource, now: Date): Promise<NormalizedJob[]> {
  const config = { ...source, enabled: true, allowedApplicationHosts: [] } as JobSource;
  return fetchSource(config, now, 500, officialSourceRequest(source));
}

function configuredSource(row: OfficialLeadRow): OfficialLeadSource {
  const url = new URL(row.canonicalUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (["apply", "application"].includes(parts.at(-1)?.toLowerCase() ?? "")) {
    parts.pop();
    url.pathname = `/${parts.join("/")}`;
  }
  const official = officialSourceForLead(url.href);
  if (!official || official.source.provider !== row.job.provider
    || official.postingId.toLowerCase() !== row.job.requisitionId.toLowerCase()) {
    throw new Error("Task-time official posting identity unavailable");
  }
  const company = row.provenance.company;
  switch (official.source.provider) {
    case "greenhouse": return { provider: "greenhouse", boardToken: official.source.boardToken,
      company };
    case "ashby": return { provider: "ashby", boardName: official.source.boardName,
      company };
    case "lever": return { provider: "lever", site: official.source.site,
      region: official.source.region, company };
    case "smartrecruiters": return { provider: "smartrecruiters",
      companyIdentifier: official.source.companyIdentifier, company };
    default: throw new Error("Task-time provider unavailable");
  }
}

/** The cached VERIFIED row is only a locator. Refetch the exact official ATS
 * posting immediately before browser work and reject closed or changed jobs. */
export async function verifyTaskTimeOfficialLead(row: OfficialLeadRow,
  runJob: OfficialJobIdentity, now: Date,
  fetchPostings: OfficialPostingFetcher = fetchLivePostings): Promise<OfficialLeadRow> {
  const epoch = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || row.status !== "open"
    || row.sk !== "VERIFIED" || row.pk !== `LEAD#${row.leadId}`
    || row.expiresAt <= epoch || row.jobKey !== officialJobKey(runJob)
    || officialJobKey(row.job) !== row.jobKey
    || row.provenance.kind !== "official-ats-api") {
    throw new Error("Task-time official lead is unavailable");
  }
  const source = configuredSource(row);
  const jobs = await fetchPostings(source, now);
  const expectedId = `${row.job.provider}:${row.job.employerId}:${row.job.requisitionId}`;
  const matches = jobs.filter(posting => posting.id.toLowerCase() === expectedId);
  if (matches.length !== 1) throw new Error("Task-time official posting is closed or duplicated");
  const refreshed = verifiedOfficialLead(source, matches[0]!, now);
  if (refreshed.leadId !== row.leadId || refreshed.jobKey !== row.jobKey
    || refreshed.sourceKey !== row.sourceKey || refreshed.canonicalUrl !== row.canonicalUrl
    || refreshed.provenance.title !== row.provenance.title
    || refreshed.provenance.company !== row.provenance.company
    || refreshed.provenance.descriptionText !== row.provenance.descriptionText) {
    throw new Error("Task-time official posting changed");
  }
  return refreshed;
}
