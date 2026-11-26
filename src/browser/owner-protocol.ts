import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base = { version: z.literal(1), requestId: z.uuid(), generation: z.uuid() };
const ownerRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("ping") }).strict(),
  z.object({ ...base, action: z.literal("inspect-tab"), tabId: z.uuid(),
    claimId: z.uuid(), jobId: z.string().min(1).max(256),
    officialUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    packageSha256: digest, artifactSha256: digest,
  }).strict(),
]);

export type OwnerRequest = z.infer<typeof ownerRequestSchema>;
export type OwnerEnvelope = { request: OwnerRequest; mac: string };

function assertSecret(secret: Buffer): void {
  if (secret.length !== 32) throw new Error("Browser owner secret must be 32 bytes");
}

function macFor(request: OwnerRequest, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(JSON.stringify(request)).digest();
}

/** Protocol only: no browser process or submission path uses this yet. */
export function signOwnerRequest(request: OwnerRequest, secret: Buffer): OwnerEnvelope {
  assertSecret(secret);
  const parsed = ownerRequestSchema.parse(request);
  return { request: parsed, mac: macFor(parsed, secret).toString("hex") };
}

/** One verifier belongs to one browser-owner generation; IDs cannot be replayed. */
export class OwnerRequestVerifier {
  private readonly seen = new Set<string>();
  private readonly secret: Buffer;

  constructor(secret: Buffer, private readonly generation: string) {
    assertSecret(secret);
    z.uuid().parse(generation);
    this.secret = Buffer.from(secret);
  }

  verify(input: unknown): OwnerRequest {
    let envelope: OwnerEnvelope;
    try {
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 16_384) throw new Error();
      envelope = z.object({ request: ownerRequestSchema, mac: digest }).strict().parse(input);
    } catch {
      throw new Error("Invalid browser-owner protocol message");
    }
    const actual = Buffer.from(envelope.mac, "hex");
    const expected = macFor(envelope.request, this.secret);
    if (!timingSafeEqual(actual, expected) || envelope.request.generation !== this.generation) {
      throw new Error("Browser-owner authentication failed");
    }
    if (this.seen.has(envelope.request.requestId)) throw new Error("Browser-owner request replay rejected");
    if (this.seen.size >= 10_000) throw new Error("Browser-owner generation must rotate");
    this.seen.add(envelope.request.requestId);
    return envelope.request;
  }
}
