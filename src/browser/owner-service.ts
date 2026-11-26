import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, createConnection, type Server } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { DomUtils, parseDocument } from "htmlparser2";
import { hasUnboundReceiptUrl } from "../application/requisition.js";
import { MAX_OWNER_MESSAGE_BYTES, OwnerRequestVerifier, signOwnerRequest,
  type OwnerClaimBinding, type OwnerRequest } from "./owner-protocol.js";
import { AgentBrowser, type BrowserSnapshot } from "./actions.js";
import { assertServiceWorkersBlocked, type BrowserRuntime } from "./runtime.js";
import { OwnerSubmitJournal, receiptPolicySha256, type OwnerReceiptPolicy,
  type OwnerSubmitIntent } from "./owner-submit-journal.js";
import type { Page, Request } from "playwright";

const MAX_OWNER_REPLY_BYTES = 65_536;

const inspectResult = z.object({
  tabId: z.uuid(), generation: z.uuid(), url: z.url(),
  title: z.string().max(512), visibleText: z.string().max(10_000),
}).strict();
const controlResult = z.object({ ref: z.string().max(64), tag: z.string().max(32),
  role: z.string().max(64).nullable(), name: z.string().max(512),
  type: z.string().max(64).nullable(), value: z.string().max(4096).nullable(),
  required: z.boolean(), options: z.array(z.string().max(512)).max(100) }).strict();
const browserResult = z.object({ tabId: z.uuid(), generation: z.uuid(),
  snapshot: z.object({ url: z.url(), title: z.string().max(512),
    visibleText: z.string().max(30_000).optional(),
    controls: z.array(controlResult).max(100) }).strict() }).strict();
const submitResult = z.object({ tabId: z.uuid(), generation: z.uuid(),
  outcome: z.enum(["receipt", "uncertain"]), receiptUrl: z.url().optional() }).strict();
const ownerReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), requestId: z.uuid(),
    result: z.union([z.literal("pong"), inspectResult, browserResult, submitResult]) }).strict(),
  z.object({ status: z.literal("error"), requestId: z.uuid(),
    error: z.string().max(200) }).strict(),
]);
type OwnerReply = z.infer<typeof ownerReply>;
type RegisteredTab = { binding: OwnerClaimBinding; inspect: () => Promise<{
  url: string; title: string; visibleText: string;
}>; browser?: AgentBrowser;
  receipt?: OwnerReceiptPolicy;
  acceptedPost?: Request;
  postAllowed?: boolean; postCount?: number; submitting?: boolean;
  navigationAttempted?: boolean };

function sameBinding(left: OwnerClaimBinding, right: OwnerClaimBinding): boolean {
  return Object.keys(left).every((key) => left[key as keyof OwnerClaimBinding]
    === right[key as keyof OwnerClaimBinding]);
}

function exactToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, "i").test(text);
}

function exactFormPost(request: Request, tab: RegisteredTab): boolean {
  const receipt = tab.receipt;
  if (!receipt || !tab.browser || request.method() !== "POST"
    || request.url() !== receipt.postUrl || !request.isNavigationRequest()
    || request.resourceType() !== "document") return false;
  try {
    if (request.frame() !== tab.browser.ownedPage().mainFrame()) return false;
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()["content-type"] ?? "")) {
      return false;
    }
    const body = request.postData();
    if (body === null) return false;
    const actual = [...new URLSearchParams(body).entries()];
    const expected = Object.entries(receipt.postFields);
    return actual.length === expected.length && actual.every(([key, value]) =>
      Object.hasOwn(receipt.postFields, key) && receipt.postFields[key] === value
      && actual.filter(([other]) => other === key).length === 1);
  } catch { return false; }
}

async function ownerReceipt(page: Page, tab: RegisteredTab, intent: OwnerSubmitIntent): Promise<string | undefined> {
  const receipt = tab.receipt;
  if (!receipt || page.isClosed() || tab.browser?.ownedPage() !== page) return undefined;
  const accepted = tab.acceptedPost;
  if (!accepted || !accepted.isNavigationRequest() || accepted.frame() !== page.mainFrame()
    || accepted.url() !== receipt.postUrl) return undefined;
  const response = await accepted.response();
  if (!response || response.status() < 200 || response.status() >= 300
    || response.url() !== receipt.postUrl) return undefined;
  if (!/^text\/html(?:;|$)/i.test(response.headers()["content-type"] ?? "")) return undefined;
  const html = await response.text().catch(() => "");
  if (html.length > 200_000) return undefined;
  const document = parseDocument(html);
  const serverBlocks = DomUtils.getElementsByTagName("*", document.children).filter((element) =>
    element.attribs?.role === "status" || element.attribs?.role === "alert"
    || element.attribs?.["data-testid"] === "application-confirmation");
  if (!serverBlocks.some((element) => {
    const text = DomUtils.getText(element);
    const descendants = DomUtils.getElementsByTagName("*", [element])
      .map((child) => DomUtils.getText(child).trim());
    return !DomUtils.getElementsByTagName("script", [element]).length
      && text.toLowerCase().includes(receipt.phrase.toLowerCase())
      && descendants.some((line) => line.toLowerCase() === `${receipt.company} — ${receipt.role}`.toLowerCase())
      && descendants.some((line) => exactToken(line, tab.binding.jobId.split(":").at(-1)!));
  })) return undefined;
  const url = page.url();
  if (url === intent.preSubmitUrl || hasUnboundReceiptUrl(tab.binding.jobId, tab.binding.officialUrl, url)) {
    return undefined;
  }
  const reference = tab.binding.jobId.split(":").at(-1)!.toLowerCase();
  const texts = await page.locator('[role="status"]:visible, [role="alert"]:visible, [data-testid="application-confirmation"]:visible')
    .allInnerTexts().catch(() => []);
  const expectedLine = `${receipt.company} — ${receipt.role}`.toLowerCase();
  const matches = texts.filter((text) => text.length <= 2000
    && text.toLowerCase().includes(receipt.phrase.toLowerCase())
    && text.toLowerCase().split("\n").some((line) => line.trim().toLowerCase() === expectedLine)
    && exactToken(text, reference));
  return matches.length === 1 && page.url() === url ? url : undefined;
}

function replyMac(reply: OwnerReply, secret: Buffer): string {
  return createHmac("sha256", secret).update(JSON.stringify(reply)).digest("hex");
}
function privateParent(path: string): Promise<void> {
  return (async () => {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || (process.getuid && parent.uid !== process.getuid())
      || (parent.mode & 0o077) !== 0) {
      throw new Error("Browser-owner socket parent must be a private directory owned by the user");
    }
  })();
}

function assertBoundSnapshot(binding: OwnerClaimBinding, snapshot: BrowserSnapshot): void {
  const official = new URL(binding.officialUrl);
  const actual = new URL(snapshot.url);
  if (actual.protocol !== "https:" || actual.origin !== official.origin
    || hasUnboundReceiptUrl(binding.jobId, binding.officialUrl, actual.href)) {
    throw new Error("Browser tab is no longer bound to the official requisition");
  }
}

async function runBrowserAction(tab: RegisteredTab,
  request: Extract<OwnerRequest, { action: "navigate-tab" | "snapshot-tab" }>,
): Promise<BrowserSnapshot> {
  const browser = tab.browser;
  if (!browser) throw new Error("Browser actions are unavailable");
  let snapshot: BrowserSnapshot;
  if (request.action === "navigate-tab") {
    if (new URL(request.url).href !== new URL(request.officialUrl).href) {
      throw new Error("Initial navigation must use the exact official posting");
    }
    if (tab.navigationAttempted) throw new Error("Owner navigation was already attempted");
    tab.navigationAttempted = true;
    snapshot = await browser.navigate(request.url);
  } else {
    snapshot = await browser.snapshot();
  }
  assertBoundSnapshot(tab.binding, snapshot);
  return snapshot;
}

async function runSubmitAction(tab: RegisteredTab, journal: OwnerSubmitJournal | undefined,
  request: Extract<OwnerRequest, { action: "submit-once" | "reconcile-submit" }>,
  generation: string,
): Promise<z.infer<typeof submitResult>> {
  if (!journal || !tab.browser || !tab.receipt) throw new Error("Owner submit staging is unavailable");
  if (tab.submitting) throw new Error("Owner submit operation is already in progress");
  tab.submitting = true;
  try {
    let intent = await journal.read(tab.binding.claimId);
    if (intent && (!sameBinding(intent.binding, tab.binding)
      || intent.receiptPolicySha256 !== receiptPolicySha256(tab.receipt))) {
      throw new Error("Submit journal belongs to another claim binding");
    }
    if (!intent && request.action === "submit-once") {
      const prepared = await tab.browser.prepareFinalClick(request.ref);
      const currentUrl = prepared.page.url();
      assertBoundSnapshot(tab.binding, { url: currentUrl, title: "", controls: [] });
      intent = await journal.claim(tab.binding, currentUrl, receiptPolicySha256(tab.receipt));
      // Only the owner that just persisted this intent may dispatch a click.
      tab.postAllowed = true;
      try { await prepared.click(); } catch { /* An uncertain click is never retried. */ }
      finally { tab.postAllowed = false; }
    }
    if (!intent) throw new Error("No final-click intent exists for this claim");
    const page = tab.browser.ownedPage();
    const receiptUrl = await ownerReceipt(page, tab, intent);
    return { tabId: request.tabId, generation,
      outcome: receiptUrl ? "receipt" : "uncertain", ...(receiptUrl ? { receiptUrl } : {}) };
  } finally { tab.submitting = false; }
}

/** Experimental owner socket. No production runner uses the staged submit operation. */
export async function startOwnerInspectionService(input: {
  socketPath: string; secret: Buffer; generation: string; journalDirectory?: string;
}): Promise<{ register(binding: OwnerClaimBinding, inspect: RegisteredTab["inspect"]): void;
  registerBrowser(binding: OwnerClaimBinding, runtime: BrowserRuntime, receipt?: RegisteredTab["receipt"]): Promise<void>;
  close(): Promise<void> }> {
  if (process.platform === "win32") {
    throw new Error("Windows owner pipe ACL has not been validated; owner service is disabled");
  }
  await privateParent(input.socketPath);
  try { await lstat(input.socketPath); throw new Error("Browser-owner socket already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const verifier = new OwnerRequestVerifier(input.secret, input.generation);
  const journal = input.journalDirectory ? new OwnerSubmitJournal(input.journalDirectory) : undefined;
  const tabs = new Map<string, RegisteredTab>();
  const server: Server = createServer((connection) => {
    connection.on("error", () => {});
    let received = Buffer.alloc(0);
    connection.setTimeout(10_000, () => connection.destroy());
    connection.on("data", (chunk: Buffer) => {
      if (received.length + chunk.length > MAX_OWNER_MESSAGE_BYTES) { connection.destroy(); return; }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      connection.pause();
      const raw = received.subarray(0, newline);
      void (async () => {
        let request: OwnerRequest;
        try {
          const parsed: unknown = JSON.parse(raw.toString("utf8"));
          const untrusted = parsed as { request?: { action?: string; tabId?: string } };
          const tab = untrusted.request && untrusted.request.action !== "ping"
            ? tabs.get(untrusted.request.tabId ?? "") : undefined;
          request = verifier.verify(raw, tab?.binding);
          let result: "pong" | z.infer<typeof inspectResult> | z.infer<typeof browserResult>
            | z.infer<typeof submitResult>;
          if (request.action === "ping") result = "pong";
          else if (request.action === "inspect-tab") {
            if (!tab) throw new Error("Browser tab is unavailable");
            const snapshot = await tab.inspect();
            assertBoundSnapshot(tab.binding, { ...snapshot, controls: [] });
            result = inspectResult.parse({ url: snapshot.url, title: snapshot.title,
              visibleText: snapshot.visibleText, tabId: request.tabId, generation: request.generation });
          } else if (request.action === "navigate-tab" || request.action === "snapshot-tab") {
            if (!tab) throw new Error("Browser tab is unavailable");
            const snapshot = await runBrowserAction(tab, request);
            result = browserResult.parse({ tabId: request.tabId,
              generation: request.generation, snapshot });
          } else {
            if (!tab) throw new Error("Browser tab is unavailable");
            result = submitResult.parse(await runSubmitAction(tab, journal, request, input.generation));
          }
          const reply: OwnerReply = { status: "ok", requestId: request.requestId, result };
          const serialized = JSON.stringify({ reply, mac: replyMac(reply, input.secret) }) + "\n";
          if (Buffer.byteLength(serialized) > MAX_OWNER_REPLY_BYTES) throw new Error("Owner reply too large");
          connection.end(serialized);
        } catch {
          // Do not reflect untrusted input, tokens, page content, or claim data in errors.
          connection.end(JSON.stringify({ status: "error", error: "Browser-owner request rejected" }) + "\n");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => { server.off("error", reject); resolve(); });
  });
  let socket;
  try {
    socket = await lstat(input.socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink()) throw new Error("Unsafe browser-owner socket");
    await chmod(input.socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(input.socketPath).catch(() => {});
    throw error;
  }
  return {
    register(binding, inspect) {
      signOwnerRequest({ version: 1, action: "inspect-tab", requestId: randomUUID(),
        generation: input.generation, ...binding }, input.secret);
      if (tabs.has(binding.tabId)) throw new Error("Browser tab ID is already registered");
      tabs.set(binding.tabId, { binding: { ...binding }, inspect });
    },
    async registerBrowser(binding, runtime, receipt) {
      signOwnerRequest({ version: 1, action: "inspect-tab", requestId: randomUUID(),
        generation: input.generation, ...binding }, input.secret);
      if (tabs.has(binding.tabId)) throw new Error("Browser tab ID is already registered");
      if ([...tabs.values()].some((tab) => tab.browser)) {
        throw new Error("An owner already holds an application browser");
      }
      const context = runtime.context;
      assertServiceWorkersBlocked(context);
      if (context.serviceWorkers().length) throw new Error("Active service workers are not allowed");
      const officialOrigin = new URL(binding.officialUrl).origin;
      if (receipt && (!journal || !receipt.company.trim() || !receipt.role.trim()
        || !receipt.phrase.trim() || new URL(receipt.postUrl).origin !== officialOrigin
        || new URL(receipt.postUrl).protocol !== "https:"
        || hasUnboundReceiptUrl(binding.jobId, binding.officialUrl, receipt.postUrl)
        || Object.keys(receipt.postFields).length === 0
        || Object.entries(receipt.postFields).some(([key, value]) => !key || typeof value !== "string"))) {
        throw new Error("Owner submit staging requires a private journal and exact receipt binding");
      }
      const tab: RegisteredTab = { binding: { ...binding },
        inspect: async () => { throw new Error("Browser tab has not been initialized"); },
        ...(receipt ? { receipt: { ...receipt, postFields: { ...receipt.postFields } } } : {}),
        postAllowed: false, postCount: 0 };
      // The owner must launch this context with serviceWorkers: "block". This
      // route prevents page JavaScript from submitting by POST while workers
      // have only navigation/snapshot access.
      await context.route("**/*", async (route) => {
        const request = route.request();
        const destination = new URL(request.url());
        const approvedPost = tab.postAllowed && tab.postCount === 0
          && exactFormPost(request, tab);
        if (approvedPost) { tab.postCount = 1; tab.acceptedPost = request; }
        if (!(approvedPost || (["GET", "HEAD"].includes(request.method())
          && destination.origin === officialOrigin))) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.fallback();
      });
      await context.routeWebSocket("**/*", (route) => route.close({ code: 1008 }));
      const browser = new AgentBrowser(context, new Set([new URL(binding.officialUrl).hostname]));
      tab.browser = browser;
      tab.inspect = async () => {
          const snapshot = await browser.snapshot();
          return { url: snapshot.url, title: snapshot.title,
            visibleText: snapshot.visibleText ?? "" };
        };
      tabs.set(binding.tabId, tab);
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const current = await lstat(input.socketPath).catch(() => null);
      if (current?.ino === socket.ino && current.dev === socket.dev) await unlink(input.socketPath);
    },
  };
}

/** A worker can reconnect after it exits; a reply must be authenticated to the same generation. */
async function sendOwnerRequest(input: { socketPath: string; secret: Buffer;
  request: OwnerRequest }): Promise<"pong" | z.infer<typeof inspectResult> | z.infer<typeof browserResult>
    | z.infer<typeof submitResult>> {
  const envelope = signOwnerRequest(input.request, input.secret);
  const raw = await new Promise<string>((resolve, reject) => {
    const connection = createConnection(input.socketPath);
    let data = "";
    connection.setTimeout(10_000, () => connection.destroy(new Error("Browser-owner request timed out")));
    connection.on("connect", () => connection.write(JSON.stringify(envelope) + "\n"));
    connection.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > MAX_OWNER_REPLY_BYTES) { connection.destroy(new Error("Browser-owner reply is too large")); return; }
      if (data.includes("\n")) { connection.end(); resolve(data.slice(0, data.indexOf("\n"))); }
    });
    connection.on("error", reject);
    connection.on("end", () => { if (!data.includes("\n")) reject(new Error("Browser-owner reply was incomplete")); });
  });
  const envelopeReply: unknown = JSON.parse(raw);
  const parsed = z.object({ reply: ownerReply, mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
    .parse(envelopeReply);
  if (parsed.reply.requestId !== input.request.requestId) throw new Error("Browser-owner reply request mismatch");
  const actual = Buffer.from(parsed.mac, "hex");
  const expected = Buffer.from(replyMac(parsed.reply, input.secret), "hex");
  if (!timingSafeEqual(actual, expected)) throw new Error("Browser-owner reply authentication failed");
  if (parsed.reply.status === "error") throw new Error(parsed.reply.error);
  if (parsed.reply.result !== "pong" && (parsed.reply.result.generation !== input.request.generation
    || input.request.action === "ping" || parsed.reply.result.tabId !== input.request.tabId)) {
    throw new Error("Browser-owner tab identity changed");
  }
  return parsed.reply.result;
}

export async function inspectOwnedTab(input: { socketPath: string; secret: Buffer;
  request: Extract<OwnerRequest, { action: "inspect-tab" | "ping" }> }): Promise<z.infer<typeof inspectResult> | "pong"> {
  const result = await sendOwnerRequest(input);
  if (result !== "pong" && ("snapshot" in result || "outcome" in result)) throw new Error("Unexpected browser action reply");
  return result;
}

/** Preview action proxy. The protocol has no final-submit operation. */
export async function requestOwnedBrowser(input: { socketPath: string; secret: Buffer;
  request: Extract<OwnerRequest, { action: "navigate-tab" | "snapshot-tab" }> })
  : Promise<z.infer<typeof browserResult>> {
  const result = await sendOwnerRequest(input);
  if (result === "pong" || !("snapshot" in result)) throw new Error("Unexpected browser action reply");
  return result;
}

/** Staging-only final click and read-only reconciliation. Production never calls this. */
export async function requestOwnedSubmit(input: { socketPath: string; secret: Buffer;
  request: Extract<OwnerRequest, { action: "submit-once" | "reconcile-submit" }> })
  : Promise<z.infer<typeof submitResult>> {
  const result = await sendOwnerRequest(input);
  if (result === "pong" || !("outcome" in result)) throw new Error("Unexpected owner submit reply");
  return result;
}
