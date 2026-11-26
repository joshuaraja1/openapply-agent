import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, createConnection, type Server } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { hasUnboundReceiptUrl } from "../application/requisition.js";
import { MAX_OWNER_MESSAGE_BYTES, OwnerRequestVerifier, signOwnerRequest,
  type OwnerClaimBinding, type OwnerRequest } from "./owner-protocol.js";

const inspectResult = z.object({
  tabId: z.uuid(), generation: z.uuid(), url: z.url(),
  title: z.string().max(512), visibleText: z.string().max(10_000),
}).strict();
const ownerReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), requestId: z.uuid(),
    result: z.union([z.literal("pong"), inspectResult]) }).strict(),
  z.object({ status: z.literal("error"), requestId: z.uuid(),
    error: z.string().max(200) }).strict(),
]);
type OwnerReply = z.infer<typeof ownerReply>;
type RegisteredTab = { binding: OwnerClaimBinding; inspect: () => Promise<{
  url: string; title: string; visibleText: string;
}> };

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

/** Local, read-only receipt evidence. No application runner uses this until owner actions are complete. */
export async function startOwnerInspectionService(input: {
  socketPath: string; secret: Buffer; generation: string;
}): Promise<{ register(binding: OwnerClaimBinding, inspect: RegisteredTab["inspect"]): void;
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
          const tab = untrusted.request?.action === "inspect-tab"
            ? tabs.get(untrusted.request.tabId ?? "") : undefined;
          request = verifier.verify(raw, tab?.binding);
          let result: "pong" | z.infer<typeof inspectResult>;
          if (request.action === "ping") result = "pong";
          else {
            if (!tab) throw new Error("Browser tab is unavailable");
            const snapshot = await tab.inspect();
            const official = new URL(request.officialUrl);
            const actual = new URL(snapshot.url);
            if (actual.protocol !== "https:" || actual.origin !== official.origin
              || hasUnboundReceiptUrl(request.jobId, request.officialUrl, actual.href)) {
              throw new Error("Browser tab is no longer bound to the official requisition");
            }
            result = inspectResult.parse({ tabId: request.tabId, generation: request.generation,
              ...snapshot });
          }
          const reply: OwnerReply = { status: "ok", requestId: request.requestId, result };
          connection.end(JSON.stringify({ reply, mac: replyMac(reply, input.secret) }) + "\n");
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
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const current = await lstat(input.socketPath).catch(() => null);
      if (current?.ino === socket.ino && current.dev === socket.dev) await unlink(input.socketPath);
    },
  };
}

/** A worker can reconnect after it exits; a reply must be authenticated to the same generation. */
export async function inspectOwnedTab(input: { socketPath: string; secret: Buffer;
  request: OwnerRequest }): Promise<z.infer<typeof inspectResult> | "pong"> {
  const envelope = signOwnerRequest(input.request, input.secret);
  const raw = await new Promise<string>((resolve, reject) => {
    const connection = createConnection(input.socketPath);
    let data = "";
    connection.setTimeout(10_000, () => connection.destroy(new Error("Browser-owner request timed out")));
    connection.on("connect", () => connection.write(JSON.stringify(envelope) + "\n"));
    connection.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data) > MAX_OWNER_MESSAGE_BYTES) { connection.destroy(new Error("Browser-owner reply is too large")); return; }
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
  if (parsed.reply.result !== "pong" && parsed.reply.result.generation !== input.request.generation) {
    throw new Error("Browser-owner generation changed");
  }
  return parsed.reply.result;
}
