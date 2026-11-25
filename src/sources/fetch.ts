import type { JobSource } from "../config.js";
import { z } from "zod";
import { sourceUrl } from "../config.js";
import { parseAshbyJobs } from "./ashby.js";
import { parseGreenhouseJobs } from "./greenhouse.js";
import { parseJsonLdJobs } from "./jsonld.js";
import { parseLeverJobs } from "./lever.js";
import { parseSmartRecruitersJobs } from "./smartrecruiters.js";
import { parseWorkdayJobs } from "./workday.js";
import type { NormalizedJob } from "../types.js";

async function fetchSmartRecruitersJobs(
  source: Extract<JobSource, { provider: "smartrecruiters" }>, maxJobs: number,
): Promise<NormalizedJob[]> {
  const summaries: NormalizedJob[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let totalFound = Number.POSITIVE_INFINITY;
  while (offset < totalFound && summaries.length <= maxJobs) {
    const url = new URL(sourceUrl(source));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(Math.min(100, maxJobs + 1 - summaries.length)));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${source.company} smartrecruiters returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const page = z.object({ offset: z.number().int().nonnegative(),
      totalFound: z.number().int().nonnegative() }).parse(payload);
    if (page.offset !== offset) throw new Error(`${source.company} smartrecruiters returned an unexpected page`);
    const jobs = parseSmartRecruitersJobs(payload, {
      companyIdentifier: source.companyIdentifier, company: source.company,
    });
    if (!jobs.length && offset < page.totalFound) throw new Error(`${source.company} smartrecruiters pagination stopped early`);
    for (const job of jobs) {
      if (seen.has(job.id)) throw new Error(`${source.company} smartrecruiters repeated a posting across pages`);
      seen.add(job.id);
      summaries.push(job);
    }
    offset += jobs.length;
    totalFound = page.totalFound;
  }

  const details: NormalizedJob[] = [];
  for (let start = 0; start < summaries.length; start += 10) {
    details.push(...await Promise.all(summaries.slice(start, start + 10).map(async (summary) => {
      const id = summary.id.split(":").at(-1);
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.companyIdentifier)}/postings/${encodeURIComponent(id ?? "")}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${source.company} smartrecruiters detail returned HTTP ${response.status}`);
      const [detail] = parseSmartRecruitersJobs([await response.json()], {
        companyIdentifier: source.companyIdentifier, company: source.company,
      });
      if (!detail || detail.id !== summary.id) throw new Error(`${source.company} smartrecruiters detail changed posting identity`);
      return detail;
    })));
  }
  return details;
}

export async function fetchSource(source: JobSource, now = new Date(), maxJobs = 1_000): Promise<NormalizedJob[]> {
  if (source.provider === "smartrecruiters") return fetchSmartRecruitersJobs(source, maxJobs);
  const response = await fetch(sourceUrl(source), source.provider === "workday" ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: source.searchText }),
  } : undefined);
  if (!response.ok) throw new Error(`${source.company} ${source.provider} returned HTTP ${response.status}`);
  if (source.provider === "jsonld") {
    return parseJsonLdJobs(await response.text(), { sourceUrl: source.url, company: source.company });
  }
  const payload: unknown = await response.json();

  if (source.provider === "greenhouse") {
    return parseGreenhouseJobs(payload, { boardToken: source.boardToken, company: source.company });
  }
  if (source.provider === "ashby") {
    return parseAshbyJobs(payload, { boardName: source.boardName, company: source.company });
  }
  if (source.provider === "lever") {
    return parseLeverJobs(payload, { site: source.site, company: source.company });
  }
  return parseWorkdayJobs(payload, {
    host: source.host,
    tenant: source.tenant,
    site: source.site,
    company: source.company,
  }, now);
}
