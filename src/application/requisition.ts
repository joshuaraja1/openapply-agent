import type { BrowserSnapshot } from "../browser/actions.js";
import type { DiscoveredJob } from "../types.js";

function segments(url: string): string[] | undefined {
  try {
    return new URL(url).pathname.split("/").map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return undefined;
  }
}

function stablePath(job: Pick<DiscoveredJob, "id" | "applicationUrl">):
  { parts: string[]; index: number } | undefined {
  const reference = job.id.split(":").at(-1)?.toLowerCase();
  if (!reference || !/^[a-z0-9_-]{6,}$/.test(reference)) return undefined;
  const parts = segments(job.applicationUrl);
  if (!parts) return undefined;
  const index = parts.indexOf(reference);
  return index > 0 ? { parts, index } : undefined;
}

export function hasStableRequisitionPath(job: Pick<DiscoveredJob, "id" | "applicationUrl">): boolean {
  return stablePath(job) !== undefined;
}

/** A changed application step must still identify the original requisition. */
export function isOriginalRequisition(page: BrowserSnapshot, job: DiscoveredJob): boolean {
  const current = new URL(page.url);
  const original = new URL(job.applicationUrl);
  if (current.protocol !== "https:" || current.origin !== original.origin) return false;
  const bound = stablePath(job);
  if (bound) {
    const actual = segments(page.url);
    return Boolean(actual) && bound.parts.slice(0, bound.index + 1)
      .every((part, index) => actual![index] === part);
  }
  return page.url === job.applicationUrl;
}

/** A receipt must remain on the original job path until a provider can prove another receipt format. */
export function hasUnboundReceiptUrl(jobId: string, applicationUrl: string, receiptUrl: string): boolean {
  const receipt = new URL(receiptUrl);
  const original = new URL(applicationUrl);
  if (receipt.protocol !== "https:" || receipt.origin !== original.origin) return true;
  const bound = stablePath({ id: jobId, applicationUrl });
  if (!bound) return receipt.href !== original.href;
  const parts = segments(receiptUrl);
  if (!parts) return true;
  return !bound.parts.slice(0, bound.index + 1).every((part, index) => parts[index] === part);
}
