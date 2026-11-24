import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MacKeychainSecretStore, getOrCreateStateKey } from "../src/storage/mac-keychain.js";

const reference = "keychain://application-state/main";

function fakeKeychain() {
  const values = new Map<string, string>();
  const factory = vi.fn((service: string, account: string) => ({
    getPassword: async () => values.get(`${service}:${account}`) ?? null,
    setPassword: async (value: string) => { values.set(`${service}:${account}`, value); },
    deletePassword: async () => values.delete(`${service}:${account}`),
  }));
  return { store: new MacKeychainSecretStore(factory, "darwin"), factory, values };
}

describe("macOS Keychain secret store", () => {
  it("stores, reads, and deletes a secret through the native entry interface", async () => {
    const { store, factory } = fakeKeychain();
    await store.put(reference, "secret-value");
    expect(await store.get(reference)).toBe("secret-value");
    expect(factory).toHaveBeenCalledWith("com.openapply.agent", "application-state/main");
    await store.delete(reference);
    expect(await store.get(reference)).toBeUndefined();
  });

  it("rejects plaintext references and empty values", async () => {
    const { store, factory } = fakeKeychain();
    await expect(store.put("password123", "secret")).rejects.toThrow("reference");
    await expect(store.put(reference, "")).rejects.toThrow("nonempty");
    expect(factory).not.toHaveBeenCalled();
  });

  it("creates a 256-bit key once and reuses it across launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-key-test-"));
    try {
      const { store, values } = fakeKeychain();
      const lock = join(root, "key.lock");
      const first = await getOrCreateStateKey(store, reference, lock);
      const second = await getOrCreateStateKey(store, reference, lock);
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
      values.set("com.openapply.agent:application-state/main", "invalid");
      await expect(getOrCreateStateKey(store, reference, lock)).rejects.toThrow("invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a second initializer out while the key lock exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-key-test-"));
    try {
      const { store } = fakeKeychain();
      const lock = join(root, "key.lock");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const slow = {
        get: vi.fn().mockImplementationOnce(async () => { await pending; return undefined; })
          .mockImplementation(store.get.bind(store)),
        put: store.put.bind(store),
        delete: store.delete.bind(store),
      };
      const first = getOrCreateStateKey(slow, reference, lock);
      await vi.waitFor(() => expect(slow.get).toHaveBeenCalled());
      await expect(getOrCreateStateKey(store, reference, lock)).rejects.toThrow();
      release();
      await first;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
