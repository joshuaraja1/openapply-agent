import { z } from "zod";
import { asString, htmlToText, isoOrNull } from "../lib/text.js";
import type { NormalizedJob } from "../types.js";

const jobSchema = z.looseObject({
  "@type": z.union([z.literal("JobPosting"), z.array(z.string())]),
  "@id": z.unknown().optional(),
  identifier: z.unknown().optional(),
  title: z.string(),
  description: z.string().optional(),
  datePosted: z.unknown().optional(),
  validThrough: z.unknown().optional(),
  employmentType: z.unknown().optional(),
  jobLocationType: z.unknown().optional(),
  url: z.string().url().optional(),
  hiringOrganization: z.unknown().optional(),
  jobLocation: z.unknown().optional(),
  baseSalary: z.unknown().optional(),
});

function isJobPosting(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>)["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

function flatten(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [value, ...flatten(record["@graph"]), ...flatten(record.itemListElement)];
}

function nameOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  return asString((value as Record<string, unknown>).name);
}

function addressOf(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || typeof first !== "object") return null;
  const address = (first as Record<string, unknown>).address;
  if (typeof address === "string") return address;
  if (!address || typeof address !== "object") return nameOf(first);
  const record = address as Record<string, unknown>;
  return [record.addressLocality, record.addressRegion, record.addressCountry].map(asString).filter(Boolean).join(", ") || null;
}

function salaryOf(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const currency = asString(record.currency);
  const inner = record.value && typeof record.value === "object" ? record.value as Record<string, unknown> : record;
  const min = asString(inner.minValue);
  const max = asString(inner.maxValue);
  const unit = asString(inner.unitText);
  if (!min && !max) return null;
  return [currency, min && max ? `${min}-${max}` : min ?? max, unit].filter(Boolean).join(" ");
}

function idOf(job: z.infer<typeof jobSchema>, sourceUrl: string): string {
  const identifier = job.identifier;
  const raw = typeof identifier === "object" && identifier
    ? asString((identifier as Record<string, unknown>).value) ?? nameOf(identifier)
    : asString(identifier);
  return raw ?? asString(job["@id"]) ?? job.url ?? sourceUrl;
}

export function parseJsonLdJobs(
  html: string,
  context: { sourceUrl: string; company: string },
): NormalizedJob[] {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const objects = scripts.flatMap((match) => {
    try { return flatten(JSON.parse(match[1] ?? "null")); } catch { return []; }
  }).filter(isJobPosting).map((item) => jobSchema.parse(item));

  return objects.map((job) => {
    const rawId = idOf(job, context.sourceUrl);
    const url = job.url ?? context.sourceUrl;
    return {
      id: `jsonld:${encodeURIComponent(rawId)}`,
      provider: "jsonld",
      company: nameOf(job.hiringOrganization) ?? context.company,
      title: job.title.trim(),
      location: addressOf(job.jobLocation),
      department: null,
      employmentType: Array.isArray(job.employmentType) ? job.employmentType.join(", ") : asString(job.employmentType),
      workplaceType: asString(job.jobLocationType),
      compensation: salaryOf(job.baseSalary),
      descriptionText: htmlToText(job.description ?? ""),
      applicationUrl: url,
      sourceUrl: url,
      sourcePublishedAt: isoOrNull(job.datePosted),
      sourceUpdatedAt: null,
    };
  });
}
