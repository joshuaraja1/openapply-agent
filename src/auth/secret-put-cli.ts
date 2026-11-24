import { MacKeychainSecretStore } from "../storage/mac-keychain.js";
import { readSecretInput } from "./secret-input.js";

const reference = process.env.OPENAPPLY_SECRET_REF;
if (!reference) throw new Error("Set OPENAPPLY_SECRET_REF to a keychain:// reference");
if (process.stdin.isTTY) throw new Error("Pipe the password through stdin; never put it in command arguments");
const value = await readSecretInput(process.stdin);
const store = new MacKeychainSecretStore();
await store.put(reference, value);
if (await store.get(reference) !== value) throw new Error("Keychain did not retain the secret");
console.log("Secret stored in macOS Keychain");
