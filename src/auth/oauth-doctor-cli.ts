import { loadAuthenticationPolicy } from "./schema.js";
import { inspectMailboxConsent } from "./oauth-doctor.js";
import { createNativeSecretStore } from "../storage/native-secret-store.js";

const path = process.env.OPENAPPLY_AUTH_POLICY;
let status: Awaited<ReturnType<typeof inspectMailboxConsent>> = "verification-failed";
try {
  if (path) status = await inspectMailboxConsent(await loadAuthenticationPolicy(path),
    createNativeSecretStore());
} catch {
  // Parser, OS secret-store, and provider errors can contain private policy data.
  // CLI output must remain a fixed status even when setup is malformed.
}
console.log(JSON.stringify({ mailboxConsent: status }));
if (status !== "verified" && status !== "disabled") process.exitCode = 1;
