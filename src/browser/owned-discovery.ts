import type { BrowserContext, Page } from "playwright";
import type { BrowserToolClient, BrowserToolResult } from "./client.js";

function reply(text: string, structuredContent?: unknown): BrowserToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

/** Small local-browser protocol for signed-in lead discovery only. */
export class OwnedDiscoveryBrowserClient implements BrowserToolClient {
  private readonly pages = new Map<number, Page>();
  private nextPageId = 1;

  private constructor(private readonly context: BrowserContext,
    private readonly allowedOrigins: ReadonlySet<string>) {}

  static async create(context: BrowserContext, searchUrls: readonly string[]): Promise<OwnedDiscoveryBrowserClient> {
    const origins = new Set(searchUrls.map((value) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Owned browser searches require credential-free HTTPS URLs");
      }
      return url.origin;
    }));
    if (!origins.size) throw new Error("At least one enabled browser search is required");
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        let origin: string;
        try { origin = new URL(request.url()).origin; }
        catch { await route.abort(); return; }
        if (!origins.has(origin)) { await route.abort(); return; }
      }
      await route.continue();
    });
    return new OwnedDiscoveryBrowserClient(context, origins);
  }

  async callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<BrowserToolResult> {
    const args = input.arguments;
    if (input.name === "name_session") return reply("owned discovery session ready");
    if (input.name === "tabs" && args.action === "new") {
      if (typeof args.url !== "string") throw new Error("Search tab needs a URL");
      const target = new URL(args.url);
      if (target.protocol !== "https:" || !this.allowedOrigins.has(target.origin)
        || target.username || target.password) {
        throw new Error("Search URL is outside approved origins");
      }
      const page = await this.context.newPage();
      try {
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (!this.allowedOrigins.has(new URL(page.url()).origin)) {
          throw new Error("Search page left its approved origin");
        }
      } catch (error) {
        await page.close();
        throw error;
      }
      const id = this.nextPageId++;
      this.pages.set(id, page);
      return reply(`opened page ${id}`, { page: { id } });
    }
    if (input.name === "tabs" && args.action === "list") {
      return reply([...this.pages].map(([id, page]) => `[${id}] ${page.url()}`).join("\n"));
    }
    if (input.name === "tabs" && args.action === "close") {
      const page = this.page(args.page);
      await page.close();
      this.pages.delete(args.page as number);
      return reply("closed");
    }
    if (input.name === "read") {
      if (args.format !== "markdown" || args.includeLinks !== true) {
        throw new Error("Owned discovery supports linked Markdown only");
      }
      const page = this.page(args.page);
      if (!this.allowedOrigins.has(new URL(page.url()).origin)) {
        throw new Error("Search page left its approved origin");
      }
      const host = new URL(page.url()).hostname;
      const selector = host.endsWith("linkedin.com") ? 'a[href*="/jobs/view/"]'
        : host === "jobright.ai" ? 'a[href*="/jobs/info/"]'
          : host.endsWith("joinhandshake.com") ? 'a[href*="/jobs/"]' : "a[href]";
      await page.locator(selector).first().waitFor({ state: "attached", timeout: 3_000 }).catch(() => {});
      const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 1_500)
        .map((anchor) => ({ href: (anchor as HTMLAnchorElement).href,
          label: anchor.getAttribute("aria-label") ?? anchor.textContent ?? "Job listing" })));
      const lines = links.flatMap(({ href, label }) => {
        try {
          const url = new URL(href);
          if (!["http:", "https:"].includes(url.protocol)) return [];
          const title = label.replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180)
            || "Job listing";
          return [`[${title}](${url.href.replaceAll(")", "%29")})`];
        } catch { return []; }
      });
      return reply(lines.join("\n"));
    }
    throw new Error(`Unsupported owned browser tool: ${input.name}`);
  }

  private page(value: unknown): Page {
    if (!Number.isInteger(value)) throw new Error("Invalid owned browser page ID");
    const page = this.pages.get(value as number);
    if (!page || page.isClosed()) throw new Error("Owned browser page is unavailable");
    return page;
  }
}
