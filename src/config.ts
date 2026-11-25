import { z } from "zod";

const baseSource = z.object({
  company: z.string().min(1),
  enabled: z.boolean().default(true),
  allowedApplicationHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i)).default([]),
});

export const sourceSchema = z.discriminatedUnion("provider", [
  baseSource.extend({ provider: z.literal("greenhouse"), boardToken: z.string().min(1) }),
  baseSource.extend({ provider: z.literal("ashby"), boardName: z.string().min(1) }),
  baseSource.extend({
    provider: z.literal("lever"),
    site: z.string().min(1),
    region: z.enum(["global", "eu"]).default("global"),
  }),
  baseSource.extend({
    provider: z.literal("smartrecruiters"),
    companyIdentifier: z.string().min(1),
  }),
  baseSource.extend({
    provider: z.literal("jsonld"),
    url: z.string().url(),
  }),
  baseSource.extend({
    provider: z.literal("workday"),
    host: z.string().min(1),
    tenant: z.string().min(1),
    site: z.string().min(1),
    searchText: z.string().default(""),
  }),
]);

export const discoveryInputSchema = z.object({
  sources: z.array(sourceSchema).min(1),
  preferredFreshnessHours: z.number().int().min(1).max(168).default(48),
  // null keeps older active postings available for backfill after recent roles.
  maximumFreshnessHours: z.number().int().min(1).max(8_760).nullable().default(null),
  includeKeywords: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  maxJobsPerSource: z.number().int().min(1).max(5_000).default(1_000),
}).refine((value) => value.maximumFreshnessHours === null
  || value.preferredFreshnessHours <= value.maximumFreshnessHours, {
  message: "preferredFreshnessHours must not exceed maximumFreshnessHours",
  path: ["preferredFreshnessHours"],
});

export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export type JobSource = z.infer<typeof sourceSchema>;

export function sourceUrl(source: JobSource): string {
  if (source.provider === "greenhouse") {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.boardToken)}/jobs?content=true`;
  }
  if (source.provider === "ashby") {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.boardName)}?includeCompensation=true`;
  }
  if (source.provider === "lever") {
    const host = source.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    return `https://${host}/v0/postings/${encodeURIComponent(source.site)}?mode=json`;
  }
  if (source.provider === "smartrecruiters") {
    return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(source.companyIdentifier)}/postings?limit=100`;
  }
  if (source.provider === "jsonld") return source.url;
  return `https://${source.host}/wday/cxs/${encodeURIComponent(source.tenant)}/${encodeURIComponent(source.site)}/jobs`;
}
