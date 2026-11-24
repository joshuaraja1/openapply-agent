import { randomBytes } from "node:crypto";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStore } from "./contracts.js";

interface KeychainEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type EntryFactory = (service: string, account: string) => KeychainEntry;

function accountFromReference(reference: string): string {
  if (!/^keychain:\/\/[A-Za-z0-9._/@:-]+$/.test(reference)) {
    throw new Error("Expected a macOS Keychain secret reference");
  }
  return reference.slice("keychain://".length);
}

const service = "com.openapply.agent";

/** Uses the native Keychain API. Secret values never enter process arguments or files. */
export class MacKeychainSecretStore implements SecretStore {
  constructor(
    private readonly entry: EntryFactory = (serviceName, account) => new AsyncEntry(serviceName, account),
    platform = process.platform,
  ) {
    if (platform !== "darwin") throw new Error("macOS Keychain is available only on macOS");
  }

  async get(reference: string): Promise<string | undefined> {
    return (await this.entry(service, accountFromReference(reference)).getPassword()) ?? undefined;
  }

  async put(reference: string, value: string): Promise<void> {
    if (!value) throw new Error("Keychain secret must be nonempty");
    await this.entry(service, accountFromReference(reference)).setPassword(value);
  }

  async delete(reference: string): Promise<void> {
    await this.entry(service, accountFromReference(reference)).deletePassword();
  }
}

/** Lock key initialization so concurrent processes cannot overwrite each other's key. */
export async function getOrCreateStateKey(store: SecretStore, reference: string, lockPath: string): Promise<Buffer> {
  const lock = resolve(lockPath);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(lock));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Key lock parent must be a real directory");
  if (process.getuid && parent.uid !== process.getuid()) throw new Error("Key lock directory has another owner");
  if (process.platform !== "win32" && (parent.mode & 0o077) !== 0) throw new Error("Key lock directory must be private");
  await mkdir(lock, { mode: 0o700 });
  try {
    const existing = await store.get(reference);
    if (existing) return decodeStateKey(existing);
    const generated = randomBytes(32).toString("base64");
    await store.put(reference, generated);
    const persisted = await store.get(reference);
    if (persisted !== generated) throw new Error("Application encryption key did not persist");
    return Buffer.from(generated, "base64");
  } finally {
    await rmdir(lock);
  }
}

function decodeStateKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error("Stored application encryption key is invalid");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("Stored application encryption key is invalid");
  return key;
}
