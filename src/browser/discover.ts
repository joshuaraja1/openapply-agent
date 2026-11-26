import { extractBrowserLeads } from "./links.js";
import { pageIdFromResult, resultText, type BrowserToolClient } from "./client.js";
import type { BrowserLead, BrowserSearchInput } from "./schema.js";
import { extractOfficialPostingLinks } from "./official-links.js";

export async function discoverBrowserLeads(
  client: BrowserToolClient,
  input: BrowserSearchInput,
  now = new Date(),
  onSearchFailure?: (label: string, error: unknown) => void,
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
  const closeOpened = async (page: number): Promise<void> => {
    try {
      const closed = await client.callTool({ name: "tabs", arguments: { action: "close", page } });
      if (closed.isError) throw new Error(resultText(closed));
    } catch (error) {
      // Closing a tab must not turn collected leads into a failed search.
      console.warn(`Could not close discovery tab ${page}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const search of input.searches.filter((item) => item.enabled)) {
    try {
      const opened = await client.callTool({ name: "tabs", arguments: { action: "new", url: search.url } });
      if (opened.isError) throw new Error(`Could not open ${search.label}: ${resultText(opened)}`);
      const page = pageIdFromResult(opened);
      try {
        const read = await client.callTool({
          name: "read",
          arguments: { page, format: "markdown", includeLinks: true, includeImages: false },
        });
        if (read.isError) throw new Error(`Could not read ${search.label}: ${resultText(read)}`);
        const found = extractBrowserLeads(resultText(read), {
          platform: search.platform,
          sourceSearchUrl: search.url,
          observedAt,
          ownedGeneric: input.runtime === "owned",
        });
        leads.push(...found);
        if (search.platform === "generic") continue;
        for (const lead of found.slice(0, input.maxBoardDetails ?? 20)) {
          try {
            const detailTab = await client.callTool({ name: "tabs",
              arguments: { action: "new", url: lead.url } });
            if (detailTab.isError) continue;
            const detailPage = pageIdFromResult(detailTab);
            try {
              const detail = await client.callTool({ name: "read",
                arguments: { page: detailPage, format: "markdown",
                  includeLinks: true, includeImages: false } });
              if (detail.isError) continue;
              for (const url of extractOfficialPostingLinks(resultText(detail))) {
                leads.push({ platform: "generic", title: lead.title, url,
                  sourceSearchUrl: search.url, observedAt });
              }
            } finally { await closeOpened(detailPage); }
          } catch {
            // One inaccessible board detail should not discard other leads.
          }
        }
      } finally { await closeOpened(page); }
    } catch (error) {
      if (!onSearchFailure) throw error;
      onSearchFailure(search.label, error);
    }
  }
  return [...new Map(leads.map((lead) => [lead.url, lead])).values()];
}
