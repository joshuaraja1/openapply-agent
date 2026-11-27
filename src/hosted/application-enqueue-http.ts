import { z } from "zod";
import { enqueueHostedApplication } from "../cloud/paid-enqueue.js";
import type { VerifySubject } from "./checkout-http.js";

const bodySchema = z.strictObject({ candidateId: z.uuid(), runId: z.uuid() });
type EnqueuePorts = Parameters<typeof enqueueHostedApplication>[3];

async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) throw new RangeError("Request is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks, size)));
}

/** Only a verified OIDC subject can enqueue a candidate-bound run. The caller
 * must provide durable run ownership, consent, billing, and FIFO queue ports. */
export async function handleApplicationEnqueueHttp(request: Request, deps: {
  appOrigin: string;
  verifySubject: VerifySubject;
  ports: EnqueuePorts;
}): Promise<Response> {
  const respond = (status: number, value: Record<string, unknown>) =>
    new Response(JSON.stringify(value), { status, headers: {
      "content-type": "application/json", "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    } });
  if (new URL(request.url).pathname !== "/api/applications/enqueue") {
    return respond(404, { error: "Not found" });
  }
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.appOrigin) {
    return respond(403, { error: "Origin not allowed" });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return respond(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return respond(401, { error: "Authentication required" }); }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return respond(415, { error: "JSON request required" });
  }
  let body: unknown;
  try { body = await readSmallJson(request); }
  catch (error) {
    return respond(error instanceof RangeError ? 413 : 400, { error: "Invalid enqueue request" });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return respond(400, { error: "Invalid enqueue request" });
  try {
    await enqueueHostedApplication(subjectId, parsed.data.candidateId,
      parsed.data.runId, deps.ports);
    return respond(202, { status: "queued" });
  } catch (error) {
    // Never expose whether another candidate's run or paid account exists.
    if (error instanceof Error && ["Hosted access unavailable",
      "Application run is not authorized",
      "Application run is not bound to this candidate"].includes(error.message)) {
      return respond(403, { error: "Application run unavailable" });
    }
    return respond(503, { error: "Application queue is temporarily unavailable" });
  }
}
