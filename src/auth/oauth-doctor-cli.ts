import { loadAuthenticationPolicy } from "./schema.js";
import { inspectMailboxConsent } from "./oauth-doctor.js";
import { createNativeSecretStore } from "../storage/native-secret-store.js";

const path = process.env.OPENAPPLY_AUTH_POLICY;
if (!path) throw new Error("Set OPENAPPLY_AUTH_POLICY to a private authentication policy file");
const status = await inspectMailboxConsent(await loadAuthenticationPolicy(path), createNativeSecretStore());
console.log(JSON.stringify({ mailboxConsent: status }));
if (status !== "verified" && status !== "disabled") process.exitCode = 1;
