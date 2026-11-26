import { createHash } from "node:crypto";
import type { ApplicationStateStore } from "../storage/contracts.js";

export interface PostingClaim { jobId: string; canonicalUrl: string; claimedAt: string }

/** Preserve requisition parameters while removing only known referral parameters. */
export function canonicalPostingUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Posting claim requires a credential-free HTTPS URL");
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(?:source|src|gh_src|trk|tracking)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.href;
}

/** A claim survives daily quota rollover and an uncertain submission. */
export class PostingClaimLedger {
  constructor(private readonly store: ApplicationStateStore<PostingClaim>) {}

  async claim(jobId: string, applicationUrl: string): Promise<"claimed" | "duplicate"> {
    if (!jobId) throw new Error("Posting claim requires a job ID");
    const canonicalUrl = canonicalPostingUrl(applicationUrl);
    const key = `posting:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const current = await this.store.read(key);
    if (current) return current.state.jobId === jobId ? "claimed" : "duplicate";
    const value = { jobId, canonicalUrl, claimedAt: new Date().toISOString() };
    if (await this.store.compareAndSwap(key, undefined, value)) return "claimed";
    const winner = await this.store.read(key);
    return winner?.state.jobId === jobId ? "claimed" : "duplicate";
  }
}
