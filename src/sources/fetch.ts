import type { JobSource } from "../config.js";
import { sourceUrl } from "../config.js";
import { parseAshbyJobs } from "./ashby.js";
import { parseGreenhouseJobs } from "./greenhouse.js";
import { parseWorkdayJobs } from "./workday.js";
import type { NormalizedJob } from "../types.js";

export async function fetchSource(source: JobSource, now = new Date()): Promise<NormalizedJob[]> {
  const response = await fetch(sourceUrl(source), source.provider === "workday" ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: source.searchText }),
  } : undefined);
  if (!response.ok) throw new Error(`${source.company} ${source.provider} returned HTTP ${response.status}`);
  const payload: unknown = await response.json();

  if (source.provider === "greenhouse") {
    return parseGreenhouseJobs(payload, { boardToken: source.boardToken, company: source.company });
  }
  if (source.provider === "ashby") {
    return parseAshbyJobs(payload, { boardName: source.boardName, company: source.company });
  }
  return parseWorkdayJobs(payload, {
    host: source.host,
    tenant: source.tenant,
    site: source.site,
    company: source.company,
  }, now);
}
