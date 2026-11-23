import { extractBrowserLeads } from "./links.js";
import { pageIdFromResult, resultText, type BrowserToolClient } from "./client.js";
import type { BrowserLead, BrowserSearchInput } from "./schema.js";

export async function discoverBrowserLeads(
  client: BrowserToolClient,
  input: BrowserSearchInput,
  now = new Date(),
): Promise<BrowserLead[]> {
  await client.callTool({
    name: "name_session",
    arguments: {
      name: "job lead search",
      category: "data-extraction",
      summary: "Search signed-in job boards and collect listing links for official-source validation.",
    },
  });

  const observedAt = now.toISOString();
  const leads: BrowserLead[] = [];
  for (const search of input.searches.filter((item) => item.enabled)) {
    const opened = await client.callTool({ name: "tabs", arguments: { action: "new", url: search.url } });
    if (opened.isError) throw new Error(`Could not open ${search.label}: ${resultText(opened)}`);
    const page = pageIdFromResult(opened);
    const read = await client.callTool({
      name: "read",
      arguments: { page, format: "markdown", includeLinks: true, includeImages: false },
    });
    if (read.isError) throw new Error(`Could not read ${search.label}: ${resultText(read)}`);
    leads.push(...extractBrowserLeads(resultText(read), {
      platform: search.platform,
      sourceSearchUrl: search.url,
      observedAt,
    }));
  }
  return [...new Map(leads.map((lead) => [lead.url, lead])).values()];
}
