import { createNativeSecretStore } from "../storage/native-secret-store.js";
import { readSecretInput } from "./secret-input.js";

const reference = process.env.OPENAPPLY_SECRET_REF;
if (!reference) throw new Error("Set OPENAPPLY_SECRET_REF to an OS secret reference");
if (/^(?:keychain|secret-service):\/\/application-state\//.test(reference)) {
  throw new Error("Application-state encryption keys cannot be overwritten by secret:put");
}
if (process.stdin.isTTY) throw new Error("Pipe the password through stdin; never put it in command arguments");
const value = await readSecretInput(process.stdin);
const store = createNativeSecretStore();
await store.put(reference, value);
if (await store.get(reference) !== value) throw new Error("OS secret store did not retain the secret");
console.log("Secret stored in the operating-system secret store");
