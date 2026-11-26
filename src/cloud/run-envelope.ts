import { createHash } from "node:crypto";
import { z } from "zod";

/** SQS receives identifiers only. Candidate material is loaded after authorization and lease claim. */
export const cloudRunEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  candidateId: z.uuid(),
  runId: z.uuid(),
  kind: z.enum(["discover", "apply"]),
  scheduledAt: z.iso.datetime(),
});
export type CloudRunEnvelope = z.infer<typeof cloudRunEnvelopeSchema>;

export function encodeCloudRunEnvelope(value: CloudRunEnvelope): {
  body: string; groupId: string; deduplicationId: string;
} {
  const envelope = cloudRunEnvelopeSchema.parse(value);
  return {
    body: JSON.stringify(envelope),
    groupId: envelope.candidateId,
    deduplicationId: createHash("sha256")
      .update(`${envelope.candidateId}:${envelope.runId}:${envelope.kind}`)
      .digest("hex"),
  };
}

export function decodeCloudRunEnvelope(body: string): CloudRunEnvelope {
  if (Buffer.byteLength(body, "utf8") > 1024) throw new Error("Cloud run message is oversized");
  return cloudRunEnvelopeSchema.parse(JSON.parse(body));
}
