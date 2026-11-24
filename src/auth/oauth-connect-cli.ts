import { loadAuthenticationPolicy } from "./schema.js";
import { connectMailboxOAuth } from "./oauth-connect.js";
import { MacKeychainSecretStore } from "../storage/mac-keychain.js";
import { assertLocalBrowserEndpoint } from "../resume/overleaf.js";
import { connectBrowserOs } from "../browser/client.js";

const policyPath = process.env.OPENAPPLY_AUTH_POLICY;
if (!policyPath) throw new Error("Set OPENAPPLY_AUTH_POLICY to a private authentication policy file");
const policy = await loadAuthenticationPolicy(policyPath);
if (process.platform !== "darwin") throw new Error("Mailbox OAuth setup currently supports macOS only");
const endpoint = process.env.OPENAPPLY_BROWSER_ENDPOINT;
if (!endpoint) throw new Error("Set OPENAPPLY_BROWSER_ENDPOINT to the local BrowserOS neo MCP endpoint");
assertLocalBrowserEndpoint(endpoint);
const connection = await connectBrowserOs(endpoint);
try {
  await connectMailboxOAuth(policy, new MacKeychainSecretStore(), async (url) => {
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
  await connection.close();
}
console.log("Mailbox connected; token stored in macOS Keychain");
