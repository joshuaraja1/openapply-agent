import { z } from "zod";
import type { JobSource } from "../config.js";
import { fetchSource } from "../sources/fetch.js";
import type { NormalizedJob } from "../types.js";
import type { BrowserLead } from "./schema.js";

export const browserLeadsFileSchema = z.object({
  leads: z.array(z.object({
    platform: z.enum(["linkedin", "jobright", "handshake", "generic"]),
    title: z.string(), url: z.string().url(), sourceSearchUrl: z.string().url(),
    observedAt: z.string().datetime(),
  })),
});

interface OfficialLead { source: JobSource; postingId: string }
const slug = /^[a-z0-9_-]{1,100}$/i;
const posting = /^[a-z0-9-]{1,128}$/i;

/** Only fixed ATS hosts can be promoted to employer postings. Board metadata is never trusted. */
export function officialSourceForLead(rawUrl: string): OfficialLead | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if ((url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io")
    && parts.length === 3 && parts[1] === "jobs" && slug.test(parts[0]!)
    && /^\d{1,20}$/.test(parts[2]!)) {
    return { source: { provider: "greenhouse", company: parts[0]!, boardToken: parts[0]!,
      enabled: true, allowedApplicationHosts: [url.hostname] }, postingId: parts[2]! };
  }
  if (url.hostname === "jobs.ashbyhq.com" && parts.length === 2
    && slug.test(parts[0]!) && posting.test(parts[1]!)) {
    return { source: { provider: "ashby", company: parts[0]!, boardName: parts[0]!,
      enabled: true, allowedApplicationHosts: [url.hostname] }, postingId: parts[1]! };
  }
  if ((url.hostname === "jobs.lever.co" || url.hostname === "jobs.eu.lever.co")
    && parts.length === 2 && slug.test(parts[0]!) && posting.test(parts[1]!)) {
    return { source: { provider: "lever", company: parts[0]!, site: parts[0]!,
      region: url.hostname === "jobs.eu.lever.co" ? "eu" : "global",
      enabled: true, allowedApplicationHosts: [url.hostname] }, postingId: parts[1]! };
  }
  if (url.hostname === "jobs.smartrecruiters.com" && parts.length === 2
    && slug.test(parts[0]!)) {
    const id = /^(\d{6,20})(?:-[a-z0-9-]+)?$/i.exec(parts[1]!);
    if (id) return { source: { provider: "smartrecruiters", company: parts[0]!,
      companyIdentifier: parts[0]!, enabled: true,
      allowedApplicationHosts: [url.hostname] }, postingId: id[1]! };
  }
  return null;
}

export interface VerifiedOfficialLead { job: NormalizedJob; source: JobSource; lead: BrowserLead }

export async function verifyOfficialBrowserLeads(leads: BrowserLead[], now = new Date(),
  fetcher: typeof fetchSource = fetchSource): Promise<VerifiedOfficialLead[]> {
  const candidates = leads.flatMap((lead) => {
    const official = officialSourceForLead(lead.url);
    return official ? [{ lead, ...official }] : [];
  });
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const source = candidate.source;
    const key = `${source.provider}:${source.company}:${source.provider === "lever" ? source.region : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const settled = await Promise.allSettled([...groups.values()].map(async (group) => {
    const source = group[0]!.source;
    const live = await fetcher(source, now);
    return group.flatMap(({ lead, postingId }) => {
      const job = live.find((item) => item.id === `${source.provider}:${source.company}:${postingId}`);
      if (!job || !job.descriptionText.trim()) return [];
      const applicationHost = new URL(job.applicationUrl).hostname;
      return [{ lead, job, source: { ...source,
        allowedApplicationHosts: [...new Set([...source.allowedApplicationHosts, applicationHost])] } }];
    });
  }));
  const verified = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  return [...new Map(verified.map((entry) => [entry.job.id, entry])).values()];
}
