import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStore } from "./contracts.js";
import { MacKeychainSecretStore } from "./mac-keychain.js";

interface SecretEntry {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type LinuxEntryFactory = (service: string, account: string) => SecretEntry;
const service = "com.openapply.agent";

/** Pins Linux credentials to persistent Secret Service; never falls back to kernel keyutils. */
export class LinuxSecretServiceStore implements SecretStore {
  constructor(private readonly entry: LinuxEntryFactory = (serviceName, account) =>
    new AsyncEntry(serviceName, account, { linux: { store: "secret-service" } }),
  platform = process.platform) {
    if (platform !== "linux") throw new Error("Secret Service is available only on Linux");
  }

  private account(reference: string): string {
    if (!/^secret-service:\/\/[A-Za-z0-9._/@:-]+$/.test(reference)) {
      throw new Error("Expected a Linux Secret Service secret reference");
    }
    return reference.slice("secret-service://".length);
  }

  async get(reference: string): Promise<string | undefined> {
    return (await this.entry(service, this.account(reference)).getPassword()) ?? undefined;
  }

  async put(reference: string, value: string): Promise<void> {
    if (!value) throw new Error("Secret Service secret must be nonempty");
    await this.entry(service, this.account(reference)).setPassword(value);
  }

  async delete(reference: string): Promise<void> {
    const entry = this.entry(service, this.account(reference));
    await entry.deletePassword();
    if (await entry.getPassword() !== null) throw new Error("Secret Service did not delete the secret");
  }
}

export function createNativeSecretStore(platform = process.platform): SecretStore {
  if (platform === "darwin") return new MacKeychainSecretStore(undefined, platform);
  if (platform === "linux") return new LinuxSecretServiceStore(undefined, platform);
  throw new Error("This platform does not yet have an OpenApply OS secret store");
}

export function stateKeyReference(platform = process.platform): string {
  if (platform === "darwin") return "keychain://application-state/main";
  if (platform === "linux") return "secret-service://application-state/main";
  throw new Error("This platform does not yet have an OpenApply OS secret store");
}
