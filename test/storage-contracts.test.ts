import { describe, expect, it } from "vitest";
import { MemoryApplicationStateStore } from "../src/storage/contracts.js";

describe("application state store contract", () => {
  it("creates, updates, and rejects stale writes", async () => {
    const store = new MemoryApplicationStateStore<{ stage: string }>();
    expect(await store.compareAndSwap("job-1", undefined, { stage: "found" })).toBe(1);
    expect(await store.compareAndSwap("job-1", undefined, { stage: "duplicate" })).toBeUndefined();
    expect(await store.compareAndSwap("job-1", 1, { stage: "ready" })).toBe(2);
    expect(await store.compareAndSwap("job-1", 1, { stage: "stale" })).toBeUndefined();
    expect(await store.read("job-1")).toEqual({ version: 2, state: { stage: "ready" } });
  });

  it("returns copies and deletes stored state", async () => {
    const store = new MemoryApplicationStateStore<{ answers: string[] }>();
    const state = { answers: ["yes"] };
    await store.compareAndSwap("job-1", undefined, state);
    state.answers.push("changed");
    const firstRead = await store.read("job-1");
    firstRead?.state.answers.push("also changed");
    expect((await store.read("job-1"))?.state.answers).toEqual(["yes"]);
    expect(await store.delete("job-1", 0)).toBe(false);
    expect(await store.delete("job-1", 1)).toBe(true);
    expect(await store.read("job-1")).toBeUndefined();
    expect(await store.compareAndSwap("job-1", undefined, { answers: ["new"] })).toBe(2);
    expect(await store.delete("job-1", 1)).toBe(false);
    expect((await store.read("job-1"))?.state.answers).toEqual(["new"]);
  });
});
