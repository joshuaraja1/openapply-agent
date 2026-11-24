import type { ApplicationStateStore } from "../storage/contracts.js";

export interface RetryRecord { failures: number }

export class RetryLedger {
  constructor(private readonly store: ApplicationStateStore<RetryRecord>, private readonly limit = 3) {}

  async exhausted(jobId: string): Promise<boolean> {
    return ((await this.store.read(`retry:${jobId}`))?.state.failures ?? 0) >= this.limit;
  }

  async fail(jobId: string): Promise<void> {
    const key = `retry:${jobId}`;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.read(key);
      if (await this.store.compareAndSwap(key, current?.version,
        { failures: (current?.state.failures ?? 0) + 1 })) return;
    }
    throw new Error("Retry record changed concurrently; inspect before another attempt");
  }
}
