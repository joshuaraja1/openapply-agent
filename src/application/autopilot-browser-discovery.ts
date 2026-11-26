import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import { discoverBrowserLeads } from "../browser/discover.js";
import { OwnedDiscoveryBrowserClient } from "../browser/owned-discovery.js";
import { launchBrowser } from "../browser/runtime.js";
import { browserSearchInputSchema, type BrowserSearchInput } from "../browser/schema.js";
import { assertLocalBrowserEndpoint } from "../resume/overleaf.js";
import { writePrivateAtomicJson } from "../storage/discovery-output.js";
import { readPrivateFile } from "../storage/private-path.js";
import type { queueRunnerConfigSchema } from "./queue-config.js";
import type { z } from "zod";

type QueueConfig = z.infer<typeof queueRunnerConfigSchema>;
type Connection = { client: BrowserToolClient; close(): Promise<void> };

export function validateScheduledBrowserSearch(config: QueueConfig, input: BrowserSearchInput): void {
  if (input.runtime !== config.browserRuntime) throw new Error("Browser search runtime must match queue runtime");
  if (input.runtime === "browseros") {
    assertLocalBrowserEndpoint(input.endpoint);
    if (new URL(input.endpoint).href !== new URL(config.browserEndpoint!).href) {
      throw new Error("Browser search endpoint must match queue endpoint");
    }
  }
  if (!input.searches.some((search) => search.enabled)) {
    throw new Error("Scheduled browser discovery needs an enabled search");
  }
  for (const search of input.searches.filter((item) => item.enabled)) {
    const url = new URL(search.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Scheduled browser searches require credential-free HTTPS URLs");
    }
  }
  if (config.browserLeadsOutputPath && resolve(config.browserLeadsOutputPath)
    === resolve(config.browserSearchInputPath!)) {
    throw new Error("Browser lead output cannot replace its search input");
  }
}

async function connectSearchBrowser(config: QueueConfig, input: BrowserSearchInput): Promise<Connection> {
  if (input.runtime === "owned") {
    const runtime = await launchBrowser({ profileDirectory: join(userInfo().homedir,
      ".openapply-agent", "browser-profile"), headless: false });
    try {
      const client = await OwnedDiscoveryBrowserClient.create(runtime.context,
        input.searches.filter((search) => search.enabled).map((search) => search.url));
      return { client, close: () => runtime.close() };
    } catch (error) { await runtime.close(); throw error; }
  }
  const neo = await connectBrowserOs(config.browserEndpoint!);
  return { client: { callTool: async (request) =>
    await neo.client.callTool(request) as BrowserToolResult }, close: () => neo.close() };
}

/** Browser leads are private, ephemeral inputs; only official live verification can queue them. */
export async function runScheduledBrowserDiscovery(config: QueueConfig,
  dependencies: {
    connect?: (config: QueueConfig, input: BrowserSearchInput) => Promise<Connection>;
    write?: typeof writePrivateAtomicJson;
  } = {}): Promise<string | undefined> {
  if (!config.browserSearchInputPath || !config.browserLeadsOutputPath) return undefined;
  const input = browserSearchInputSchema.parse(JSON.parse(await readPrivateFile(config.browserSearchInputPath)));
  validateScheduledBrowserSearch(config, input);
  const connection = await (dependencies.connect ?? connectSearchBrowser)(config, input);
  let leads;
  try {
    leads = await discoverBrowserLeads(connection.client, input, new Date(), (label, error) => {
      console.warn(`Skipped browser search ${label}: ${error instanceof Error ? error.message : String(error)}`);
    });
  } finally {
    // The owned browser profile lock must be released before the queue opens it.
    await connection.close();
  }
  await (dependencies.write ?? writePrivateAtomicJson)(config.browserLeadsOutputPath,
    { generatedAt: new Date().toISOString(), leads });
  console.log(`Collected ${leads.length} browser lead(s) for official verification`);
  return config.browserLeadsOutputPath;
}
