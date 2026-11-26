import { createHash } from "node:crypto";
import type { ApplicationStateStore } from "../storage/contracts.js";

export interface PostingClaim { jobId: string; canonicalUrl: string; claimedAt: string }
export type PostingClaimReceipt = { status: "claimed" | "duplicate"; createdVersion?: number };

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
    return (await this.claimWithReceipt(jobId, applicationUrl)).status;
  }

  async claimWithReceipt(jobId: string, applicationUrl: string): Promise<PostingClaimReceipt> {
    if (!jobId) throw new Error("Posting claim requires a job ID");
    const canonicalUrl = canonicalPostingUrl(applicationUrl);
    const key = `posting:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const current = await this.store.read(key);
    if (current) return { status: current.state.jobId === jobId ? "claimed" : "duplicate" };
    const value = { jobId, canonicalUrl, claimedAt: new Date().toISOString() };
    const createdVersion = await this.store.compareAndSwap(key, undefined, value);
    if (createdVersion !== undefined) return { status: "claimed", createdVersion };
    const winner = await this.store.read(key);
    return { status: winner?.state.jobId === jobId ? "claimed" : "duplicate" };
  }

  /** Release only this run's new claim, and only before any browser attempt. */
  async releaseNewClaim(jobId: string, applicationUrl: string, createdVersion: number): Promise<boolean> {
    const canonicalUrl = canonicalPostingUrl(applicationUrl);
    const key = `posting:${createHash("sha256").update(canonicalUrl).digest("hex")}`;
    const current = await this.store.read(key);
    if (current?.version !== createdVersion || current.state.jobId !== jobId
      || current.state.canonicalUrl !== canonicalUrl) return false;
    return await this.store.delete(key, createdVersion);
  }
}
