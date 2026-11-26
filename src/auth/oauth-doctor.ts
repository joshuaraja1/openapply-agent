import type { SecretStore } from "../storage/contracts.js";
import type { AuthenticationPolicy } from "./schema.js";
import { getMailboxAccessToken } from "./oauth-token.js";

export type MailboxConsentStatus = "disabled" | "consent-required" | "verified" | "verification-failed";

/** Explicit check of the saved grant. Never returns tokens, addresses, client IDs, or provider errors. */
export async function inspectMailboxConsent(policy: AuthenticationPolicy, secrets: SecretStore,
  fetcher: typeof fetch = fetch, now = Date.now()): Promise<MailboxConsentStatus> {
  const config = policy.emailVerification;
  if (!config.enabled) return "disabled";
  if (!config.oauthSecretRef) return "consent-required";
  let saved: string | undefined;
  try { saved = await secrets.get(config.oauthSecretRef); }
  catch { return "verification-failed"; }
  if (!saved) return "consent-required";
  try {
    await getMailboxAccessToken(policy, secrets, fetcher, now, false);
    return "verified";
  } catch { return "verification-failed"; }
}
