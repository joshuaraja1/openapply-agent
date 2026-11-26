import type { BrowserContext, ElementHandle, Page } from "playwright";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface BrowserControl {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  type: string | null;
  value: string | null;
  required: boolean;
  options: string[];
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  controls: BrowserControl[];
  visibleText?: string;
}

export class AgentBrowser {
  private page: Page | undefined;
  private routingReady = false;
  private generation = 0;
  private controls = new Map<string, ElementHandle<HTMLElement>>();

  constructor(
    private readonly context: BrowserContext,
    private readonly allowedHosts: ReadonlySet<string>,
    private readonly approvedArtifacts: ReadonlyMap<string, string> = new Map(),
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
        await route.fallback();
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
    const pageText = await page.evaluate(() => {
      let text = document.body?.innerText ?? "";
      // document.body.innerText omits open shadow roots. Include their visible
      // text so a challenge or legal attestation cannot disappear from a scan.
      const visit = (root: Document | ShadowRoot) => {
        for (const host of root.querySelectorAll("*")) {
          if (!host.shadowRoot || text.length > 50_000) continue;
          const walker = document.createTreeWalker(host.shadowRoot, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode()) && text.length <= 50_000) {
            const parent = node.parentElement;
            if (!parent || parent.closest('script, style, [hidden], [aria-hidden="true"]')
              || !parent.getClientRects().length) continue;
            text += `\n${node.textContent ?? ""}`;
          }
          visit(host.shadowRoot);
        }
      };
      visit(document);
      return { text: text.slice(0, 50_000), overflow: text.length > 50_000 };
    });
    if (pageText.overflow) throw new Error("Application page text exceeds the safe snapshot limit");
    const visibleText = pageText.text;
    // Playwright's CSS locator traverses open shadow roots. Explicit roles
    // include custom controls that do not use native select/input elements.
    const handles = await page.locator("a, button, input, textarea, select, [role=button], [role=combobox]").elementHandles();
    const controls: BrowserControl[] = [];
    for (const handle of handles) {
      if (!(await handle.isVisible())) continue;
      const ref = `${this.generation}:${controls.length}`;
      const tag = await handle.evaluate((element) => (element as Element).tagName.toLowerCase());
      const role = await handle.getAttribute("role");
      const metadata = await handle.evaluate((element) => {
        const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const labelNode = field.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
        labelNode?.querySelectorAll("input, select, textarea, button").forEach((control) => control.remove());
        const label = labelNode?.textContent?.trim();
        const root = field.getRootNode?.() as Document | ShadowRoot | undefined;
        const labelledBy = field.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean)
          .map((id) => root?.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
        const customCombo = field.getAttribute("role") === "combobox" && field.tagName !== "SELECT";
        const nativeValue = ["INPUT", "TEXTAREA", "SELECT"].includes(field.tagName)
          ? field.value ?? null : null;
        return {
          label: label || field.getAttribute("aria-label") || labelledBy || field.getAttribute("placeholder")
            || field.getAttribute("name") || field.textContent || "",
          required: field.matches(":required") || field.getAttribute("aria-required") === "true",
          options: field.tagName === "SELECT"
            ? Array.from((field as HTMLSelectElement).options, (option) => option.label.trim()) : [],
          value: field.tagName === "INPUT" && ["password", "hidden"].includes((field as HTMLInputElement).type)
            ? null : nativeValue !== null ? nativeValue
              : customCombo ? field.getAttribute("aria-valuetext") ?? field.textContent?.trim() ?? null : null,
        };
      });
      const name = metadata.label;
      const type = await handle.getAttribute("type");
      const value = metadata.value;
      this.controls.set(ref, handle as ElementHandle<HTMLElement>);
      controls.push({ ref, tag, role, name: name.trim(), type, value,
        required: metadata.required, options: metadata.options });
    }
    return { url: page.url(), title: await page.title(), controls, visibleText };
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
      const effectiveSubmit = await handle.evaluate((element) => element.tagName === "BUTTON"
        ? (element as HTMLButtonElement).type === "submit" : element.tagName === "INPUT"
          && ["submit", "image"].includes((element as HTMLInputElement).type));
      const label = ((await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => ""))).trim();
      if (effectiveSubmit || type?.toLowerCase() === "submit"
        || /\b(submit|apply now|send application)\b/i.test(label)) {
        throw new Error("Submission requires a separate approved action");
      }
      await handle.click();
    } else if (action === "fill" && value !== undefined) {
      await handle.fill(value);
      if (await handle.inputValue() !== value) throw new Error("Form value was not accepted");
    }
    else if (action === "select" && value !== undefined) {
      const tag = await handle.evaluate((element) => element.tagName.toLowerCase());
      if (tag === "select") {
        await handle.selectOption({ label: value });
        const selected = await handle.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.label.trim());
        if (selected !== value) throw new Error("Selected option was not accepted");
      } else if (await handle.getAttribute("role") === "combobox") {
        if (await handle.evaluate((element) => element.tagName === "BUTTON"
          ? (element as HTMLButtonElement).type === "submit" : element.tagName === "INPUT"
            && ["submit", "image"].includes((element as HTMLInputElement).type))) {
          throw new Error("Submission requires a separate approved action");
        }
        const ownership = [await handle.getAttribute("aria-controls"), await handle.getAttribute("aria-owns")]
          .filter((entry): entry is string => Boolean(entry)).flatMap((entry) => entry.trim().split(/\s+/));
        if (ownership.length < 1 || new Set(ownership).size !== 1) {
          throw new Error("Combobox listbox ownership is unavailable or ambiguous");
        }
        const listbox = page.locator(`[id=${JSON.stringify(ownership[0])}][role="listbox"]`);
        await handle.click();
        await listbox.waitFor({ state: "visible", timeout: 3_000 });
        if (await listbox.count() !== 1) throw new Error("Combobox listbox is ambiguous");
        const option = listbox.getByRole("option", { name: value, exact: true });
        await option.first().waitFor({ state: "visible", timeout: 3_000 });
        if (await option.count() !== 1) throw new Error("Combobox option is ambiguous");
        await option.click();
        const selected = await handle.evaluate((element) =>
          ["INPUT", "TEXTAREA"].includes(element.tagName)
            ? (element as HTMLInputElement).value
            : element.getAttribute("aria-valuetext") ?? element.textContent?.trim() ?? "");
        if (selected.trim() !== value) throw new Error("Selected option was not accepted");
      } else throw new Error("Selected control is not a combobox");
    }
    else if (action === "upload" && value !== undefined) {
      const expectedHash = this.approvedArtifacts.get(resolve(value));
      if (!expectedHash) throw new Error("Upload artifact is not approved for this application");
      const bytes = await readFile(value);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== expectedHash) throw new Error("Upload artifact changed after verification");
      await handle.setInputFiles({ name: basename(value), mimeType: "application/pdf", buffer: bytes });
    }
    else throw new Error("This browser action requires a value");
    const pages = this.context.pages();
    const popup = pages.find((candidate) => !existingPages.has(candidate) && !candidate.isClosed());
    if (popup) this.page = popup;
    this.assertAllowedPage();
    return this.snapshot();
  }

  private accountForm(snapshot: BrowserSnapshot, kind: "login" | "registration") {
    const controls = snapshot.controls;
    const one = (pattern: RegExp) => {
      const matches = controls.filter((control) => control.tag === "input" && pattern.test(control.name.trim()));
      if (matches.length !== 1) throw new Error("Portal credential form is ambiguous");
      return matches[0]!;
    };
    const email = one(/^(email|email address|e-mail)$/i);
    const password = one(kind === "registration" ? /^(password|create password)$/i
      : /^(password|account password)$/i);
    const confirmation = kind === "registration"
      ? one(/^(confirm password|password confirmation|re-enter password)$/i) : undefined;
    if (password.type !== "password" || (confirmation && confirmation.type !== "password")) {
      throw new Error("Portal password fields are not protected inputs");
    }
    const submit = controls.filter((control) => control.tag === "button"
      && (kind === "registration" ? /^(create account|sign up|register)$/i
        : /^(sign in|log in|login)$/i).test(control.name.trim()));
    if (submit.length !== 1 || /\b(captcha|verify you are human|security question|i agree|by (?:creating|registering|signing up|clicking)\b.{0,160}\b(?:agree|accept)|agree to (?:the )?(?:terms|privacy)|accept (?:the )?(?:terms|privacy))\b/i
      .test(snapshot.visibleText ?? "") || controls.some((control) => control.required
        && control.tag !== "button" && ![email, password, confirmation].includes(control))) {
      throw new Error("Portal credential form requires human review");
    }
    return { email, password, confirmation, submit: submit[0]! };
  }

  private async assertCredentialFormTarget(
    ref: string, fields: readonly BrowserControl[],
  ): Promise<ElementHandle<HTMLElement>> {
    const handle = this.controls.get(ref);
    if (!handle || !(await handle.evaluate((element) => element.isConnected))) {
      throw new Error("Portal credential submit control changed");
    }
    const formTarget = await handle.evaluate((element) => {
      const form = (element as HTMLButtonElement).form;
      return form ? { method: form.method.toLowerCase(), action: form.action } : null;
    });
    // Script-only login flows do not expose a destination that can be checked.
    if (!formTarget) throw new Error("Portal credential form requires human review");
    const destination = new URL(formTarget.action);
    const current = new URL(this.currentUrl());
    if (formTarget.method !== "post" || destination.protocol !== "https:"
      || destination.username || destination.password || destination.origin !== current.origin) {
      throw new Error("Portal credential form has an unsafe submission destination");
    }
    for (const field of fields) {
      const input = this.controls.get(field.ref);
      if (!input || !(await input.evaluate((element, button) =>
        (element as HTMLInputElement).form === (button as HTMLButtonElement).form, handle))) {
        throw new Error("Portal credential fields belong to another form");
      }
    }
    return handle;
  }

  private async submitAccountForm(kind: "login" | "registration", email: string, password: string) {
    if (!email || !password) throw new Error("Portal credentials are unavailable");
    let snapshot = await this.snapshot();
    const initial = this.accountForm(snapshot, kind);
    await this.assertCredentialFormTarget(initial.submit.ref,
      [initial.email, initial.password, ...(initial.confirmation ? [initial.confirmation] : [])]);
    for (const field of ["email", "password", ...(kind === "registration" ? ["confirmation"] as const : [])] as const) {
      const controls = this.accountForm(snapshot, kind);
      snapshot = await this.act(controls[field]!.ref, "fill", field === "email" ? email : password);
    }
    const controls = this.accountForm(snapshot, kind);
    if (controls.email.value !== email) throw new Error("Portal credential form changed during fill");
    const handle = await this.assertCredentialFormTarget(controls.submit.ref,
      [controls.email, controls.password, ...(controls.confirmation ? [controls.confirmation] : [])]);
    this.controls.clear();
    this.generation += 1;
    await handle.click();
    this.assertAllowedPage();
    return this.snapshot();
  }

  async authenticate(email: string, password: string): Promise<BrowserSnapshot> {
    return this.submitAccountForm("login", email, password);
  }

  async register(email: string, password: string): Promise<BrowserSnapshot> {
    return this.submitAccountForm("registration", email, password);
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
    if (await page.getByText(expectedConfirmation, { exact: false }).filter({ visible: true }).count()) {
      throw new Error("Confirmation was already visible before submission");
    }
    const existingPages = new Set(this.context.pages());
    await handle.click();
    const popup = this.context.pages().find((candidate) => !existingPages.has(candidate) && !candidate.isClosed());
    if (popup) this.page = popup;
    this.assertAllowedPage();
    const confirmation = this.requirePage().getByText(expectedConfirmation, { exact: false })
      .filter({ visible: true }).first();
    await confirmation.waitFor({ timeout: 10000 });
    return (await confirmation.innerText()).trim();
  }

  async receiptContext(): Promise<string> {
    this.assertAllowedPage();
    const text = await this.requirePage().evaluate(() => document.body?.innerText ?? "");
    if (text.length > 8_000) throw new Error("Employer receipt text exceeds the verification limit");
    return text;
  }

  /** Owner-only final-click preparation. The caller must persist its intent first. */
  async prepareFinalClick(ref: string): Promise<{ page: Page; click: () => Promise<void> }> {
    const page = this.requirePage();
    const handle = this.controls.get(ref);
    if (!handle || !ref.startsWith(`${this.generation}:`)) throw new Error("Stale browser control reference");
    if (!(await handle.evaluate((element) => element.isConnected))) throw new Error("Submit control changed");
    const type = await handle.getAttribute("type");
    const label = ((await handle.getAttribute("aria-label")) ?? (await handle.innerText().catch(() => ""))).trim();
    if (type !== "submit" && !/\b(submit|apply now|send application)\b/i.test(label)) {
      throw new Error("Selected control is not a submit action");
    }
    return { page, click: async () => {
      this.controls.clear();
      this.generation += 1;
      await handle.click();
    } };
  }

  ownedPage(): Page {
    return this.requirePage();
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
