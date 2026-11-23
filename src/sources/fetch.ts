import type { JobSource } from "../config.js";
import { sourceUrl } from "../config.js";
import { parseAshbyJobs } from "./ashby.js";
import { parseGreenhouseJobs } from "./greenhouse.js";
import { parseJsonLdJobs } from "./jsonld.js";
import { parseLeverJobs } from "./lever.js";
import { parseSmartRecruitersJobs } from "./smartrecruiters.js";
import { parseWorkdayJobs } from "./workday.js";
import type { NormalizedJob } from "../types.js";

export async function fetchSource(source: JobSource, now = new Date()): Promise<NormalizedJob[]> {
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
  if (source.provider === "smartrecruiters") {
    const summaries = parseSmartRecruitersJobs(payload, {
      companyIdentifier: source.companyIdentifier,
      company: source.company,
    });
    const details = await Promise.all(summaries.map(async (summary) => {
      const id = summary.id.split(":").at(-1);
      const detailResponse = await fetch(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.companyIdentifier)}/postings/${encodeURIComponent(id ?? "")}`);
      if (!detailResponse.ok) return summary;
      const [detail] = parseSmartRecruitersJobs([await detailResponse.json()], {
        companyIdentifier: source.companyIdentifier,
        company: source.company,
      });
      return detail ?? summary;
    }));
    return details;
  }
  return parseWorkdayJobs(payload, {
    host: source.host,
    tenant: source.tenant,
    site: source.site,
    company: source.company,
  }, now);
}
