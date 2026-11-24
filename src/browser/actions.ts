import type { BrowserContext, ElementHandle, Page } from "playwright";

export interface BrowserControl {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  value: string | null;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  controls: BrowserControl[];
}

export class AgentBrowser {
  private page: Page | undefined;
  private routingReady = false;
  private generation = 0;
  private controls = new Map<string, ElementHandle<HTMLElement>>();

  constructor(
    private readonly context: BrowserContext,
    private readonly allowedHosts: ReadonlySet<string>,
  ) {}

  async navigate(url: string): Promise<BrowserSnapshot> {
    const destination = new URL(url);
    if (destination.protocol !== "https:" || !this.allowedHosts.has(destination.hostname.toLowerCase())) {
      throw new Error("Navigation destination is outside the approved employer domain");
    }
    this.controls.clear();
    this.generation += 1;
    if (!this.routingReady) {
      await this.context.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          const target = new URL(request.url());
          if (target.protocol !== "https:" || !this.allowedHosts.has(target.hostname.toLowerCase())) {
            await route.abort();
            return;
          }
        }
        await route.continue();
      });
      this.routingReady = true;
    }
    this.page ??= await this.context.newPage();
    await this.page.goto(destination.href, { waitUntil: "domcontentloaded" });
    this.assertAllowedPage();
    return this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    this.assertAllowedPage();
    this.controls.clear();
    this.generation += 1;
    const handles = await page.locator("a, button, input, textarea, select, [role=button]").elementHandles();
    const controls: BrowserControl[] = [];
    for (const handle of handles) {
      if (!(await handle.isVisible())) continue;
      const ref = `${this.generation}:${controls.length}`;
      const tag = await handle.evaluate((element) => (element as Element).tagName.toLowerCase());
      const role = await handle.getAttribute("role");
      const name = (await handle.getAttribute("aria-label"))
        ?? (await handle.getAttribute("name"))
        ?? (await handle.innerText().catch(() => ""));
      const type = await handle.getAttribute("type");
      const value = ["input", "textarea", "select"].includes(tag)
        ? await handle.inputValue()
        : null;
      this.controls.set(ref, handle as ElementHandle<HTMLElement>);
      controls.push({ ref, tag, role, name: name.trim(), type, value });
    }
    return { url: page.url(), title: await page.title(), controls };
  }

  async act(ref: string, action: "click" | "fill" | "select" | "upload", value?: string): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const handle = this.controls.get(ref);
    if (!handle || !ref.startsWith(`${this.generation}:`)) throw new Error("Stale browser control reference");
    if (!(await handle.evaluate((element) => element.isConnected))) throw new Error("Browser control changed; take a new snapshot");
    if (action === "click") await handle.click();
    else if (action === "fill" && value !== undefined) await handle.fill(value);
    else if (action === "select" && value !== undefined) await handle.selectOption(value);
    else if (action === "upload" && value !== undefined) await handle.setInputFiles(value);
    else throw new Error("This browser action requires a value");
    this.assertAllowedPage();
    return this.snapshot();
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Navigate to an approved page first");
    return this.page;
  }

  private assertAllowedPage(): void {
    const page = this.requirePage();
    const current = new URL(page.url());
    if (current.protocol !== "https:" || !this.allowedHosts.has(current.hostname.toLowerCase())) {
      throw new Error("Browser left the approved employer domain");
    }
  }
}
