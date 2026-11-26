import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pageIdFromResult, resultText, type BrowserToolClient, type BrowserToolResult } from "./client.js";
import type { BrowserControl, BrowserSnapshot } from "./actions.js";
import type { FormAction } from "../application/form-mapper.js";

function success(result: BrowserToolResult, step: string): string {
  if (result.isError) throw new Error(`BrowserOS ${step} failed`);
  return resultText(result);
}

export function parseNeoSnapshot(message: string): BrowserSnapshot & { visibleText: string } {
  const marker = message.match(/\[UNTRUSTED_PAGE_CONTENT nonce=([a-f0-9]+) origin=(https:\/\/[^\]\s]+)\]/);
  if (!marker) throw new Error("BrowserOS did not provide a trusted HTTPS page origin");
  const url = new URL(marker[2]!);
  const end = message.indexOf(`[END_UNTRUSTED_PAGE_CONTENT nonce=${marker[1]}]`, marker.index!);
  if (end < 0) throw new Error("BrowserOS page snapshot is incomplete");
  const visibleText = message.slice(marker.index! + marker[0].length, end);
  const controls: BrowserControl[] = [];
  for (const line of visibleText.split("\n")) {
    const match = line.match(/^\s*- (textbox|searchbox|button|link|combobox|checkbox|radio)(?: "([^"]*)")?([^\n]*?)\[ref=(e\d+)\](?:: "([^"]*)")?/);
    if (!match) continue;
    const [, role, label, attributes, ref, value] = match;
    const name = label ?? "";
    const submit = role === "button" && /\b(submit|apply now|send application)\b/i.test(name!);
    const resume = role === "button" && /^(?:(?:upload|attach|add|choose|select)\s+)?(?:resume|résumé|cv)(?:\s+(?:file|document))?$/i
      .test(name!.trim());
    controls.push({ ref: ref!, role: role!, name,
      required: attributes!.includes("[required]") || ["checkbox", "radio", "combobox"].includes(role!),
      tag: role === "link" ? "a" : role === "button" && !resume ? "button"
        : role === "combobox" ? "select" : "input",
      type: resume ? "file" : submit ? "submit" : role === "button" && attributes!.includes("[type=button]")
        ? "button" : role === "checkbox" || role === "radio" ? role! : null,
      value: value ?? null, options: [],
    });
  }
  return { url: url.href, title: "", controls, visibleText };
}

export class NeoApplicationBrowser {
  private page: number | undefined;
  private group: string | undefined;
  private latest: (BrowserSnapshot & { visibleText: string }) | undefined;

  constructor(private readonly client: BrowserToolClient,
    private readonly allowedHosts: ReadonlySet<string>,
    private readonly approvedArtifacts: ReadonlyMap<string, string>) {}

  currentUrl(): string {
    if (!this.latest) throw new Error("Application page is not open");
    return this.latest.url;
  }

  pageId(): number | undefined { return this.page; }
  groupId(): string | undefined { return this.group; }

  // BrowserOS snapshots cannot prove that password inputs and the submit
  // control share a same-origin POST form. Let a human sign in or register in
  // the persistent browser; application recovery resumes afterward.
  async register(_email: string, _password: string): Promise<BrowserSnapshot> {
    throw new Error("BrowserOS account registration requires human completion");
  }

  async authenticate(_email: string, _password: string): Promise<BrowserSnapshot> {
    throw new Error("BrowserOS portal sign-in requires human completion");
  }

  private async listedGroup(pageId: number): Promise<string> {
    const listing = success(await this.client.callTool({ name: "tabs", arguments: { action: "list" } }), "tab listing");
    const rows = listing.split("\n").filter((entry) =>
      new RegExp(`^\\s*\\[${pageId}\\]\\s`).test(entry));
    if (rows.length !== 1) throw new Error("BrowserOS handoff tab identity is ambiguous");
    const group = rows[0]?.match(/\[group ([a-f0-9]{16,})\]/i)?.[1];
    if (!group) throw new Error("BrowserOS handoff tab identity is unavailable");
    return group;
  }

  async attach(pageId: number, expectedUrl: string, expectedGroupId: string,
    allowChangedEmployerUrl = false): Promise<BrowserSnapshot> {
    const snapshot = await this.inspectHandoff(pageId, expectedGroupId);
    if (snapshot.url !== expectedUrl && !allowChangedEmployerUrl) {
      throw new Error("Handoff page moved; inspect it before resuming");
    }
    return snapshot;
  }

  async inspectHandoff(pageId: number, expectedGroupId: string): Promise<BrowserSnapshot & { visibleText: string }> {
    if (!Number.isInteger(pageId) || pageId < 1) throw new Error("Invalid BrowserOS handoff page");
    const group = await this.listedGroup(pageId);
    if (group !== expectedGroupId) throw new Error("BrowserOS handoff tab identity changed");
    this.page = pageId;
    this.group = group;
    return this.snapshot();
  }

  private assertAllowed(snapshot: BrowserSnapshot): void {
    const url = new URL(snapshot.url);
    if (url.protocol !== "https:" || !this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error("BrowserOS left the approved employer domain");
    }
  }

  async navigate(url: string): Promise<BrowserSnapshot> {
    const target = new URL(url);
    if (target.protocol !== "https:" || !this.allowedHosts.has(target.hostname.toLowerCase())) {
      throw new Error("Navigation destination is outside the approved employer domain");
    }
    success(await this.client.callTool({ name: "name_session", arguments: {
      name: "application runner", category: "productivity", summary: "Complete a guarded employer application",
    } }), "session");
    success(await this.client.callTool({ name: "tabs", arguments: { action: "list" } }), "tab listing");
    const opened = await this.client.callTool({ name: "tabs", arguments: { action: "new", url } });
    success(opened, "open application");
    this.page = pageIdFromResult(opened);
    this.group = await this.listedGroup(this.page);
    return this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshot & { visibleText: string }> {
    if (this.page === undefined) throw new Error("Application page is not open");
    const result = await this.client.callTool({ name: "snapshot", arguments: {
      page: this.page, mode: "interactive",
    } });
    const snapshot = parseNeoSnapshot(success(result, "snapshot"));
    this.assertAllowed(snapshot);
    this.latest = snapshot;
    return snapshot;
  }

  async act(ref: string, action: "click" | "fill" | "select" | "upload", value?: string): Promise<BrowserSnapshot> {
    if (this.page === undefined || !this.latest) throw new Error("Application action needs a current page");
    const control = this.latest.controls.find((entry) => entry.ref === ref);
    if (!control) throw new Error("BrowserOS control changed; take a new snapshot");
    if (action === "click" && control.tag === "button" && control.type === "button"
      && /^(next|continue|save and continue|continue to next step)$/i.test(control.name.trim())) {
      success(await this.client.callTool({ name: "act", arguments: {
        page: this.page, kind: "click", ref, diff: "none",
      } }), "continue application");
      return this.snapshot();
    }
    if (!value) throw new Error("Application action needs a value");
    if (action === "fill" && control.tag === "input" && control.type !== "file") {
      success(await this.client.callTool({ name: "act", arguments: {
        page: this.page, kind: "fill", ref, value, sensitive: true, diff: "none",
      } }), "fill");
      const after = await this.snapshot();
      const updated = after.controls.find((entry) => entry.name === control.name && entry.tag === control.tag);
      if (updated?.value !== value) throw new Error(`BrowserOS did not retain ${control.name}`);
      return after;
    }
    if (action === "upload" && control.type === "file") {
      await this.upload(ref, value);
      return this.snapshot();
    }
    throw new Error("Unsupported BrowserOS application action");
  }

  async fillBatch(actions: FormAction[]): Promise<BrowserSnapshot> {
    if (this.page === undefined || !this.latest) throw new Error("Application page is not open");
    if (actions.some((action) => action.action === "select")) {
      throw new Error("BrowserOS cannot verify select options on this page");
    }
    const before = this.latest;
    const fills = actions.filter((action) => action.action === "fill").map((action) => {
      const control = before.controls.find((entry) => entry.name === action.name
        && entry.tag === action.tag && entry.type === action.type);
      if (!control) throw new Error(`BrowserOS field changed: ${action.name}`);
      return { ref: control.ref, value: action.value, name: action.name };
    });
    if (fills.length) {
      success(await this.client.callTool({ name: "act", arguments: {
        page: this.page, kind: "fill", fields: fills.map(({ ref, value }) => ({ ref, value })),
        sensitive: true, diff: "none",
      } }), "form fill");
    }
    let after = await this.snapshot();
    if (after.url !== before.url) throw new Error("Application page changed during form filling");
    for (const field of fills) {
      const matches = after.controls.filter((entry) => entry.name === field.name && entry.type !== "file");
      if (matches.length !== 1 || matches[0]!.value !== field.value) {
        throw new Error(`BrowserOS did not retain ${field.name}`);
      }
    }
    for (const action of actions.filter((entry) => entry.action === "upload")) {
      const controls = after.controls.filter((entry) => entry.name === action.name && entry.type === "file");
      if (controls.length !== 1) throw new Error("Résumé upload control changed");
      await this.upload(controls[0]!.ref, action.value);
      after = await this.snapshot();
      if (after.url !== before.url) throw new Error("Application page changed during résumé upload");
    }
    return after;
  }

  private async upload(ref: string, path: string): Promise<void> {
    const absolute = resolve(path);
    const approved = this.approvedArtifacts.get(absolute);
    if (!approved) throw new Error("Résumé artifact is not approved for this application");
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("Résumé upload path is invalid");
    }
    const hash = () => readFile(absolute).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    if (await hash() !== approved) throw new Error("Résumé artifact changed before upload");
    const uploaded = success(await this.client.callTool({ name: "upload", arguments: {
      page: this.page, ref, files: [absolute],
    } }), "upload");
    if (!uploaded.includes("Selected 1 file(s)")) throw new Error("BrowserOS did not confirm résumé selection");
    if (await hash() !== approved) throw new Error("Résumé artifact changed during upload");
  }

  async submit(ref: string, expectedConfirmation: string): Promise<string> {
    if (this.page === undefined || !this.latest || !expectedConfirmation.trim()) {
      throw new Error("Submission confirmation is required");
    }
    const expectedUrl = this.currentUrl();
    const previousControl = this.latest.controls.find((entry) => entry.ref === ref && entry.type === "submit");
    if (!previousControl) throw new Error("Submission control changed");
    const before = await this.snapshot();
    if (before.url !== expectedUrl || before.visibleText.includes(expectedConfirmation)) {
      throw new Error("Confirmation already visible or application page changed");
    }
    const controls = before.controls.filter((entry) => entry.name === previousControl.name && entry.type === "submit");
    if (controls.length !== 1) throw new Error("Submission control changed");
    success(await this.client.callTool({ name: "act", arguments: {
      page: this.page, kind: "click", ref: controls[0]!.ref, diff: "none",
    } }), "submission");
    const waited = success(await this.client.callTool({ name: "wait", arguments: {
      page: this.page, for: "text", value: expectedConfirmation, timeout: 10000,
    } }), "confirmation wait");
    if (!waited.startsWith("matched")) throw new Error("Employer confirmation was not found");
    const after = await this.snapshot();
    if (!after.visibleText.includes(expectedConfirmation)) throw new Error("Employer confirmation was not visible");
    const receipts = after.visibleText.split("\n").filter((line) => line.includes(expectedConfirmation));
    if (receipts.length !== 1 || receipts[0]!.length > 2_000) {
      throw new Error("Employer confirmation text is ambiguous");
    }
    return receipts[0]!.trim();
  }

  async receiptContext(): Promise<string> {
    if (!this.latest) throw new Error("Employer receipt is not open");
    if (this.latest.visibleText.length > 8_000) {
      throw new Error("Employer receipt text exceeds the verification limit");
    }
    return this.latest.visibleText;
  }
}
