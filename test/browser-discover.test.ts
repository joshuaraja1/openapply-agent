import { describe, expect, it, vi } from "vitest";
import { discoverBrowserLeads } from "../src/browser/discover.js";
import type { BrowserToolClient, BrowserToolResult } from "../src/browser/client.js";
import type { BrowserSearchInput } from "../src/browser/schema.js";

describe("BrowserOS lead discovery", () => {
  it("opens enabled searches, extracts links, and skips disabled searches", async () => {
    const callTool = vi.fn(async (request: { name: string; arguments: Record<string, unknown> }): Promise<BrowserToolResult> => {
      if (request.name === "tabs") return { structuredContent: { page: { id: 17 } } };
      if (request.name === "read") {
        return { content: [{ type: "text", text: "[Software Engineer](https://www.linkedin.com/jobs/view/123/?tracking=one)" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const client: BrowserToolClient = { callTool };
    const input: BrowserSearchInput = {
      runtime: "browseros",
      endpoint: "http://127.0.0.1:9010/mcp",
      maxBoardDetails: 0,
      searches: [
        { label: "LinkedIn", platform: "linkedin", url: "https://www.linkedin.com/jobs/search/", enabled: true },
        { label: "Disabled", platform: "jobright", url: "https://jobright.ai/jobs/recommend", enabled: false },
      ],
    };

    const leads = await discoverBrowserLeads(client, input, new Date("2026-01-02T03:04:05Z"));

    expect(leads).toEqual([expect.objectContaining({
      platform: "linkedin",
      title: "Software Engineer",
      url: "https://www.linkedin.com/jobs/view/123/",
      observedAt: "2026-01-02T03:04:05.000Z",
    })]);
    expect(callTool.mock.calls.map(([request]) => request.name)).toEqual(["name_session", "tabs", "read"]);
  });

  it("extracts official ATS links from a bounded set of board details", async () => {
    const callTool = vi.fn(async (request: { name: string; arguments: Record<string, unknown> }): Promise<BrowserToolResult> => {
      if (request.name === "tabs") return { structuredContent: { page: { id: 17 } } };
      if (request.name === "read") {
        const count = callTool.mock.calls.filter(([item]) => item.name === "read").length;
        return { content: [{ type: "text", text: count === 1
          ? "[Engineer](https://www.linkedin.com/jobs/view/123/)"
          : "[Apply](https://job-boards.greenhouse.io/example/jobs/1234)" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const input: BrowserSearchInput = { runtime: "browseros",
      endpoint: "http://127.0.0.1:9010/mcp", maxBoardDetails: 1,
      searches: [{ label: "LinkedIn", platform: "linkedin",
        url: "https://www.linkedin.com/jobs/search/", enabled: true }] };
    const leads = await discoverBrowserLeads({ callTool }, input);
    expect(leads.map((entry) => entry.url)).toEqual([
      "https://www.linkedin.com/jobs/view/123/",
      "https://job-boards.greenhouse.io/example/jobs/1234",
    ]);
  });
});
