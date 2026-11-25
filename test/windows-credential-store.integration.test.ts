import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WindowsCredentialManagerStore } from "../src/storage/native-secret-store.js";
import { getOrCreateStateKey } from "../src/storage/mac-keychain.js";

describe.skipIf(process.platform !== "win32")("native Windows Credential Manager", () => {
  it("persists, reads, and deletes one isolated credential", async () => {
    const store = new WindowsCredentialManagerStore();
    const reference = `credential-manager://ci/${randomUUID()}`;
    const value = randomUUID();
    try {
      await store.put(reference, value);
      expect(await store.get(reference)).toBe(value);
    } finally {
      await store.delete(reference);
    }
    expect(await store.get(reference)).toBeUndefined();
  });
  it("persists a Windows application-state key under a private lock", async () => {
    const store = new WindowsCredentialManagerStore();
    const reference = `credential-manager://ci-state/${randomUUID()}`;
    try {
      const first = await getOrCreateStateKey(store, reference);
      expect(first).toHaveLength(32);
      expect(await getOrCreateStateKey(store, reference)).toEqual(first);
    } finally {
      await store.delete(reference);
    }
  }, 30_000);
});
