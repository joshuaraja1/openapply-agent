import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface BrowserToolResult {
  content?: Array<{ type: string; text?: string | undefined }> | undefined;
  structuredContent?: unknown | undefined;
  isError?: boolean | undefined;
}

export interface BrowserToolClient {
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<BrowserToolResult>;
}

export async function connectBrowserOs(endpoint: string): Promise<{ client: Client; close(): Promise<void> }> {
  const client = new Client({ name: "openapply-agent", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function resultText(result: BrowserToolResult): string {
  return (result.content ?? []).flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n");
}

function findPageId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "page" || key === "pageId" || key === "id") && typeof child === "number") return child;
    const nested = findPageId(child);
    if (nested !== null) return nested;
  }
  return null;
}

export function pageIdFromResult(result: BrowserToolResult): number {
  const structured = findPageId(result.structuredContent);
  if (structured !== null) return structured;
  const match = resultText(result).match(/\bpage(?:Id)?[=: #]+(\d+)\b/i);
  if (match?.[1]) return Number(match[1]);
  throw new Error("BrowserOS did not return a page id for the opened search tab");
}
