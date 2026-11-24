import type { BrowserContext, ElementHandle, Page } from "playwright";
import { resolve } from "node:path";

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
    private readonly approvedArtifacts: ReadonlySet<string> = new Set(),
  ) {}

  currentUrl(): string {
    return this.requirePage().url();
  }

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
      const value = null;
      this.controls.set(ref, handle as ElementHandle<HTMLElement>);
      controls.push({ ref, tag, role, name: name.trim(), type, value });
    }
    return { url: page.url(), title: await page.title(), controls };
  }

  async act(ref: string, action: "click" | "fill" | "select" | "upload", value?: string): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const handle = this.controls.get(ref);
    if (!handle || !ref.startsWith(`${this.generation}:`)) throw new Error("Stale browser control reference");
    this.controls.clear();
    this.generation += 1;
    if (!(await handle.evaluate((element) => element.isConnected))) throw new Error("Browser control changed; take a new snapshot");
    const existingPages = new Set(this.context.pages());
    if (action === "click") {
      const type = await handle.getAttribute("type");
      const label = ((await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => ""))).trim();
      if (type === "submit" || /\b(submit|apply now|send application)\b/i.test(label)) {
        throw new Error("Submission requires a separate approved action");
      }
      await handle.click();
    } else if (action === "fill" && value !== undefined) {
      await handle.fill(value);
      if (await handle.inputValue() !== value) throw new Error("Form value was not accepted");
    }
    else if (action === "select" && value !== undefined) await handle.selectOption(value);
    else if (action === "upload" && value !== undefined) {
      if (!this.approvedArtifacts.has(resolve(value))) throw new Error("Upload artifact is not approved for this application");
      await handle.setInputFiles(value);
    }
    else throw new Error("This browser action requires a value");
    const pages = this.context.pages();
    const popup = pages.find((candidate) => !existingPages.has(candidate) && !candidate.isClosed());
    if (popup) this.page = popup;
    this.assertAllowedPage();
    return this.snapshot();
  }

  async submit(ref: string, expectedConfirmation: string): Promise<string> {
    if (!expectedConfirmation.trim()) throw new Error("Expected employer confirmation is required");
    const page = this.requirePage();
    const handle = this.controls.get(ref);
    if (!handle || !ref.startsWith(`${this.generation}:`)) throw new Error("Stale browser control reference");
    this.controls.clear();
    this.generation += 1;
    if (!(await handle.evaluate((element) => element.isConnected))) throw new Error("Submit control changed");
    const type = await handle.getAttribute("type");
    const label = ((await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => ""))).trim();
    if (type !== "submit" && !/\b(submit|apply now|send application)\b/i.test(label)) {
      throw new Error("Selected control is not a submit action");
    }
    if (await page.getByText(expectedConfirmation, { exact: false }).count()) {
      throw new Error("Confirmation was already visible before submission");
    }
    const existingPages = new Set(this.context.pages());
    await handle.click();
    const popup = this.context.pages().find((candidate) => !existingPages.has(candidate) && !candidate.isClosed());
    if (popup) this.page = popup;
    this.assertAllowedPage();
    const confirmation = this.requirePage().getByText(expectedConfirmation, { exact: false }).first();
    await confirmation.waitFor({ timeout: 10000 });
    return (await confirmation.innerText()).trim();
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
