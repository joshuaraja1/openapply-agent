import { describe, expect, it } from "vitest";
import { decodeCloudRunEnvelope, encodeCloudRunEnvelope } from "../src/cloud/run-envelope.js";

const message = {
  version: 1 as const,
  candidateId: "4fd29cf4-edda-4e66-9440-172c167bb0aa",
  runId: "621e5016-1649-43b2-b97c-79219a9ac703",
  kind: "apply" as const,
  scheduledAt: "2026-11-26T22:00:00.000Z",
};

describe("cloud run envelope", () => {
  it("contains only opaque IDs and has stable per-candidate FIFO keys", () => {
    const first = encodeCloudRunEnvelope(message);
    expect(decodeCloudRunEnvelope(first.body)).toEqual(message);
    expect(first.groupId).toBe(message.candidateId);
    expect(encodeCloudRunEnvelope(message).deduplicationId).toBe(first.deduplicationId);
    expect(encodeCloudRunEnvelope({ ...message, runId: "c7f715df-0f49-4be7-a529-40c8ca660f92" })
      .deduplicationId).not.toBe(first.deduplicationId);
  });

  it("rejects candidate data and oversized messages", () => {
    expect(() => decodeCloudRunEnvelope(JSON.stringify({ ...message, resume: "private" }))).toThrow();
    expect(() => decodeCloudRunEnvelope("x".repeat(1025))).toThrow("oversized");
  });
});
