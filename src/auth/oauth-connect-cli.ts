import { loadAuthenticationPolicy } from "./schema.js";
import { connectMailboxOAuth } from "./oauth-connect.js";
import { createNativeSecretStore } from "../storage/native-secret-store.js";
import { assertLocalBrowserEndpoint } from "../resume/overleaf.js";
import { connectBrowserOs } from "../browser/client.js";
import { assertMailboxConsentUrl, openOwnedMailboxConsent } from "./owned-consent.js";
import type { BrowserRuntime } from "../browser/runtime.js";

const policyPath = process.env.OPENAPPLY_AUTH_POLICY;
if (!policyPath) throw new Error("Set OPENAPPLY_AUTH_POLICY to a private authentication policy file");
const policy = await loadAuthenticationPolicy(policyPath);
const endpoint = process.env.OPENAPPLY_BROWSER_ENDPOINT;
if (endpoint) assertLocalBrowserEndpoint(endpoint);
const connection = endpoint ? await connectBrowserOs(endpoint) : undefined;
let ownedRuntime: BrowserRuntime | undefined;
try {
  await connectMailboxOAuth(policy, createNativeSecretStore(), async (url) => {
    if (!connection) {
      ownedRuntime = await openOwnedMailboxConsent(url, policy);
      return;
    }
    assertMailboxConsentUrl(url, policy);
    const client = connection.client;
    await client.callTool({ name: "name_session", arguments: {
      name: "mailbox consent", category: "productivity",
      summary: "Connect a read-only mailbox to OpenApply",
    } });
    await client.callTool({ name: "tabs", arguments: { action: "list" } });
    const opened = await client.callTool({ name: "tabs", arguments: { action: "new", url } });
    if (opened.isError) throw new Error("BrowserOS could not open the mailbox consent page");
  });
} finally {
  await ownedRuntime?.close();
  await connection?.close();
}
console.log("Mailbox connected; token stored in the operating-system secret store");
