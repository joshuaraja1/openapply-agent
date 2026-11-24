import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";

const directories: string[] = [];
async function fixture(key = Buffer.alloc(32, 7)) {
  const directory = await mkdtemp(join(tmpdir(), "openapply-state-"));
  directories.push(directory);
  const path = join(directory, "applications.enc");
  return { path, store: new EncryptedApplicationStateStore<{ stage: string }>(path, key) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("encrypted application state", () => {
  it("survives restart without writing plaintext", async () => {
    const { path, store } = await fixture();
    expect(await store.compareAndSwap("job-1", undefined, { stage: "applying" })).toBe(1);
    expect(await readFile(path, "utf8")).not.toContain("applying");
    const restarted = new EncryptedApplicationStateStore<{ stage: string }>(path, Buffer.alloc(32, 7));
    expect(await restarted.read("job-1")).toEqual({ version: 1, state: { stage: "applying" } });
    expect(await restarted.compareAndSwap("job-1", 1, { stage: "submitted" })).toBe(2);
  });

  it("serializes competing writes and preserves generations after deletion", async () => {
    const { path, store } = await fixture();
    const other = new EncryptedApplicationStateStore<{ stage: string }>(path, Buffer.alloc(32, 7));
    const results = await Promise.allSettled([
      store.compareAndSwap("job-1", undefined, { stage: "first" }),
      other.compareAndSwap("job-1", undefined, { stage: "second" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled" && result.value === 1)).toHaveLength(1);
    expect(await store.delete("job-1", 1)).toBe(true);
    expect(await store.compareAndSwap("job-1", undefined, { stage: "recreated" })).toBe(2);
    expect(await store.delete("job-1", 1)).toBe(false);
  });

  it("rejects tampering and an incorrect key", async () => {
    const { path, store } = await fixture();
    await store.compareAndSwap("job-1", undefined, { stage: "ready" });
    const wrongKey = new EncryptedApplicationStateStore(path, Buffer.alloc(32, 8));
    await expect(wrongKey.read("job-1")).rejects.toThrow();
    const sealed = JSON.parse(await readFile(path, "utf8")) as { ciphertext: string };
    sealed.ciphertext = Buffer.from("changed").toString("base64");
    await writeFile(path, JSON.stringify(sealed));
    await expect(store.read("job-1")).rejects.toThrow();
  });
});
