import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { connectBrowserOs, type BrowserToolClient, type BrowserToolResult } from "./client.js";
import { discoverBrowserLeads } from "./discover.js";
import { browserSearchInputSchema } from "./schema.js";

const inputPath = process.env.OPENAPPLY_BROWSER_SEARCH ?? "examples/browser-searches.json";
const outputPath = process.env.OPENAPPLY_BROWSER_OUTPUT ?? "output/browser-leads.json";
const input = browserSearchInputSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
const connection = await connectBrowserOs(input.endpoint);
const browserClient: BrowserToolClient = {
  async callTool(request) {
    return await connection.client.callTool(request) as BrowserToolResult;
  },
};

try {
  const leads = await discoverBrowserLeads(browserClient, input);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), leads }, null, 2)}\n`);
  console.log(`Collected ${leads.length} browser lead(s) in ${outputPath}`);
} finally {
  await connection.close();
}
