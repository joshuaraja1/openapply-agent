import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "./client.js";
import { launchBrowser } from "./runtime.js";
import { OwnedDiscoveryBrowserClient } from "./owned-discovery.js";
import { discoverBrowserLeads } from "./discover.js";
import { browserSearchInputSchema } from "./schema.js";

const inputPath = process.env.OPENAPPLY_BROWSER_SEARCH ?? "examples/browser-searches.json";
const outputPath = process.env.OPENAPPLY_BROWSER_OUTPUT ?? "output/browser-leads.json";
const input = browserSearchInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
const connection = input.runtime === "owned"
  ? await (async () => {
    const runtime = await launchBrowser({ profileDirectory: join(userInfo().homedir,
      ".openapply-agent", "browser-profile"), headless: false });
    try {
      const client = await OwnedDiscoveryBrowserClient.create(runtime.context,
        input.searches.filter((search) => search.enabled).map((search) => search.url));
      return { client, close: () => runtime.close() };
    } catch (error) { await runtime.close(); throw error; }
  })()
  : await (async () => {
    const neo = await connectBrowserOs(input.endpoint);
    const client: BrowserToolClient = { callTool: async (request) =>
      await neo.client.callTool(request) as BrowserToolResult };
    return { client, close: () => neo.close() };
  })();

try {
  const leads = await discoverBrowserLeads(connection.client, input);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), leads }, null, 2)}\n`);
  console.log(`Collected ${leads.length} browser lead(s) in ${outputPath}`);
} finally {
  await connection.close();
}
