import type { BrowserSnapshot } from "../browser/actions.js";
import type { DiscoveredJob } from "../types.js";

function segments(url: string): string[] {
  return new URL(url).pathname.split("/").map((part) => decodeURIComponent(part).toLowerCase());
}

function stablePath(job: Pick<DiscoveredJob, "id" | "applicationUrl">):
  { parts: string[]; index: number } | undefined {
  const reference = job.id.split(":").at(-1)?.toLowerCase();
  if (!reference || !/^[a-z0-9_-]{6,}$/.test(reference)) return undefined;
  const parts = segments(job.applicationUrl);
  const index = parts.indexOf(reference);
  return index > 0 ? { parts, index } : undefined;
}

/** A changed application step must still identify the original requisition. */
export function isOriginalRequisition(page: BrowserSnapshot, job: DiscoveredJob): boolean {
  if (page.url === job.applicationUrl) return true;
  const current = new URL(page.url);
  const original = new URL(job.applicationUrl);
  if (current.protocol !== "https:" || current.hostname !== original.hostname) return false;
  const bound = stablePath(job);
  if (bound) {
    const actual = segments(page.url);
    return bound.parts.slice(0, bound.index + 1).every((part, index) => actual[index] === part);
  }
  const text = (page.visibleText ?? "").toLowerCase().replace(/\s+/g, " ");
  return text.includes(job.title.toLowerCase()) && text.includes(job.company.toLowerCase());
}

/** A same-host receipt must not be for a different requisition-shaped URL. */
export function hasConflictingReceiptUrl(jobId: string, applicationUrl: string, receiptUrl: string): boolean {
  const receipt = new URL(receiptUrl);
  const original = new URL(applicationUrl);
  if (receipt.protocol !== "https:" || receipt.hostname !== original.hostname) return true;
  const bound = stablePath({ id: jobId, applicationUrl });
  if (!bound) return false;
  const parts = segments(receiptUrl);
  if (!bound.parts.slice(0, bound.index).every((part, index) => parts[index] === part)) return false;
  const candidate = parts[bound.index];
  const expected = bound.parts[bound.index]!;
  if (!candidate || candidate === expected) return false;
  const numeric = /^\d{6,}$/.test(expected) && /^\d{6,}$/.test(candidate);
  const uuid = /^[a-f0-9-]{24,}$/.test(expected) && /^[a-f0-9-]{24,}$/.test(candidate);
  return numeric || uuid;
}
