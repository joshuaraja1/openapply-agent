import type { ApplicationStateStore } from "../storage/contracts.js";

export interface DailyQuotaRecord { date: string; reservedJobIds: string[] }

/** A reservation is deliberately retained after a crash or uncertain submission. */
export class DailyQuota {
  constructor(private readonly store: ApplicationStateStore<DailyQuotaRecord>) {}

  async availability(date: string, jobId: string, cap: number): Promise<"available" | "duplicate" | "full"> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !jobId || !Number.isInteger(cap) || cap < 1) {
      throw new Error("Invalid daily quota request");
    }
    const current = await this.store.read(`daily-quota:${date}`);
    const ids = current?.state.reservedJobIds ?? [];
    if (ids.includes(jobId)) return "duplicate";
    return ids.length >= cap ? "full" : "available";
  }

  async reserve(date: string, jobId: string, cap: number): Promise<"reserved" | "duplicate" | "full"> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !jobId || !Number.isInteger(cap) || cap < 1) {
      throw new Error("Invalid daily quota request");
    }
    const key = `daily-quota:${date}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.read(key);
      const ids = current?.state.reservedJobIds ?? [];
      if (ids.includes(jobId)) return "duplicate";
      if (ids.length >= cap) return "full";
      const next = { date, reservedJobIds: [...ids, jobId] };
      if (await this.store.compareAndSwap(key, current?.version, next)) return "reserved";
    }
    throw new Error("Daily quota changed concurrently; retry the run");
  }

  /** Release only a reservation whose job was stopped before browser activity. */
  async releaseBeforeBrowser(date: string, jobId: string): Promise<void> {
    const key = `daily-quota:${date}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.read(key);
      if (!current?.state.reservedJobIds.includes(jobId)) return;
      const next = { ...current.state,
        reservedJobIds: current.state.reservedJobIds.filter((id) => id !== jobId) };
      if (await this.store.compareAndSwap(key, current.version, next)) return;
    }
    throw new Error("Daily quota changed concurrently; cannot release pre-browser reservation");
  }
}
