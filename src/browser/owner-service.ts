import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, createConnection, type Server } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { hasUnboundReceiptUrl } from "../application/requisition.js";
import { MAX_OWNER_MESSAGE_BYTES, OwnerRequestVerifier, signOwnerRequest,
  type OwnerClaimBinding, type OwnerRequest } from "./owner-protocol.js";
import { AgentBrowser, type BrowserSnapshot } from "./actions.js";
import { assertServiceWorkersBlocked, type BrowserRuntime } from "./runtime.js";

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
const ownerReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), requestId: z.uuid(),
    result: z.union([z.literal("pong"), inspectResult, browserResult]) }).strict(),
  z.object({ status: z.literal("error"), requestId: z.uuid(),
    error: z.string().max(200) }).strict(),
]);
type OwnerReply = z.infer<typeof ownerReply>;
type RegisteredTab = { binding: OwnerClaimBinding; inspect: () => Promise<{
  url: string; title: string; visibleText: string;
}>; browser?: Pick<AgentBrowser, "navigate" | "snapshot">;
  navigationAttempted?: boolean; initialDocumentRequested?: boolean };

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

/** Experimental owner socket. No production runner wiring or final-submit operation. */
export async function startOwnerInspectionService(input: {
  socketPath: string; secret: Buffer; generation: string;
}): Promise<{ register(binding: OwnerClaimBinding, inspect: RegisteredTab["inspect"]): void;
  registerBrowser(binding: OwnerClaimBinding, runtime: BrowserRuntime,
    readOnlyGetUrls?: readonly string[]): Promise<void>;
  close(): Promise<void> }> {
  if (process.platform === "win32") {
    throw new Error("Windows owner pipe ACL has not been validated; owner service is disabled");
  }
  await privateParent(input.socketPath);
  try { await lstat(input.socketPath); throw new Error("Browser-owner socket already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const verifier = new OwnerRequestVerifier(input.secret, input.generation);
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
          let result: "pong" | z.infer<typeof inspectResult> | z.infer<typeof browserResult>;
          if (request.action === "ping") result = "pong";
          else if (request.action === "inspect-tab") {
            if (!tab) throw new Error("Browser tab is unavailable");
            const snapshot = await tab.inspect();
            assertBoundSnapshot(tab.binding, { ...snapshot, controls: [] });
            result = inspectResult.parse({ url: snapshot.url, title: snapshot.title,
              visibleText: snapshot.visibleText, tabId: request.tabId, generation: request.generation });
          } else {
            if (!tab) throw new Error("Browser tab is unavailable");
            const snapshot = await runBrowserAction(tab, request);
            result = browserResult.parse({ tabId: request.tabId,
              generation: request.generation, snapshot });
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
    async registerBrowser(binding, runtime, readOnlyGetUrls = []) {
      signOwnerRequest({ version: 1, action: "inspect-tab", requestId: randomUUID(),
        generation: input.generation, ...binding }, input.secret);
      if (tabs.has(binding.tabId)) throw new Error("Browser tab ID is already registered");
      if ([...tabs.values()].some((tab) => tab.browser)) {
        throw new Error("An owner already holds an application browser");
      }
      const context = runtime.context;
      assertServiceWorkersBlocked(context);
      if (context.serviceWorkers().length) throw new Error("Active service workers are not allowed");
      // launchBrowser closes its initial blank page. Any page created since
      // then could have live requests or sockets that routing cannot revoke.
      if (context.pages().length > 0 || context.backgroundPages().length > 0) {
        await runtime.close();
        throw new Error("Browser-owner context contained a preexisting page; start a fresh owner generation");
      }
      const official = new URL(binding.officialUrl);
      const approvedReadOnlyUrls = new Set(readOnlyGetUrls.map((value) => {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.origin !== official.origin || url.hash
          || url.username || url.password || url.href === official.href) {
          throw new Error("Browser-owner read-only URL is not an exact approved employer URL");
        }
        return url.href;
      }));
      const tab: RegisteredTab = { binding: { ...binding },
        inspect: async () => { throw new Error("Browser tab has not been initialized"); } };
      // The owner must launch this context with serviceWorkers: "block". This
      // route allows only the first posting document and explicitly reviewed
      // read-only GET URLs. HTTP method alone cannot identify a safe request.
      await context.route("**/*", async (route) => {
        const request = route.request();
        const destination = new URL(request.url());
        const initialDocument = tab.navigationAttempted && !tab.initialDocumentRequested
          && request.method() === "GET" && request.isNavigationRequest()
          && request.resourceType() === "document" && destination.href === official.href;
        if (initialDocument) tab.initialDocumentRequested = true;
        const reviewedRead = ["GET", "HEAD"].includes(request.method())
          && approvedReadOnlyUrls.has(destination.href);
        if (!initialDocument && !reviewedRead) {
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
  request: OwnerRequest }): Promise<"pong" | z.infer<typeof inspectResult> | z.infer<typeof browserResult>> {
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
  if (result !== "pong" && "snapshot" in result) throw new Error("Unexpected browser action reply");
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
