import { describe, expect, it, vi } from "vitest";
import { LinuxSecretServiceStore, createNativeSecretStore, stateKeyReference }
  from "../src/storage/native-secret-store.js";
import { getOrCreateStateKey } from "../src/storage/mac-keychain.js";
import { randomUUID } from "node:crypto";

describe("native secret-store selection", () => {
  it("uses the Linux Secret Service reference without accepting another platform's prefix", async () => {
    const values = new Map<string, string>();
    const factory = vi.fn((service: string, account: string) => ({
      getPassword: async () => values.get(`${service}:${account}`) ?? null,
      setPassword: async (value: string) => { values.set(`${service}:${account}`, value); },
      deletePassword: async () => values.delete(`${service}:${account}`),
    }));
    const store = new LinuxSecretServiceStore(factory, "linux");
    const reference = "secret-service://portal/account";
    await store.put(reference, "private-value");
    expect(await store.get(reference)).toBe("private-value");
    expect(factory).toHaveBeenCalledWith("com.openapply.agent", "portal/account");
    await store.delete(reference);
    expect(await store.get(reference)).toBeUndefined();
    const key = await getOrCreateStateKey(store, `secret-service://test/${randomUUID()}`);
    expect(key).toHaveLength(32);
    await expect(store.put("keychain://portal/account", "value")).rejects.toThrow("reference");
    await expect(store.put(reference, "")).rejects.toThrow("nonempty");
  });

  it("selects the existing macOS key namespace and fails closed on unsupported systems", () => {
    expect(stateKeyReference("darwin")).toBe("keychain://application-state/main");
    expect(stateKeyReference("linux")).toBe("secret-service://application-state/main");
    expect(createNativeSecretStore("linux")).toBeInstanceOf(LinuxSecretServiceStore);
    expect(() => stateKeyReference("win32")).toThrow("does not yet have");
    expect(() => createNativeSecretStore("win32")).toThrow("does not yet have");
    expect(() => new LinuxSecretServiceStore(undefined, "darwin"))
      .toThrow("only on Linux");
  });

  it("does not report deletion when a Linux credential remains readable", async () => {
    const store = new LinuxSecretServiceStore(() => ({
      getPassword: async () => "still-present",
      setPassword: async () => {}, deletePassword: async () => false,
    }), "linux");
    await expect(store.delete("secret-service://portal/account"))
      .rejects.toThrow("did not delete");
  });
});
