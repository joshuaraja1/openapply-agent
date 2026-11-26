import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OwnerRequestVerifier, signOwnerRequest } from "../src/browser/owner-protocol.js";

const hash = "a".repeat(64);
const generation = randomUUID();
const inspect = () => ({ version: 1 as const, action: "inspect-tab" as const,
  requestId: randomUUID(), generation, tabId: randomUUID(), claimId: randomUUID(),
  jobId: "ashby:example:123", officialUrl: "https://jobs.example.test/123",
  packageSha256: hash, artifactSha256: hash });

describe("inactive browser-owner request protocol", () => {
  it("accepts a bound inspection once and rejects replay or changed job bindings", () => {
    const secret = randomBytes(32);
    const verifier = new OwnerRequestVerifier(secret, generation);
    const envelope = signOwnerRequest(inspect(), secret);
    expect(verifier.verify(envelope)).toEqual(envelope.request);
    expect(() => verifier.verify(envelope)).toThrow("replay");
    expect(() => new OwnerRequestVerifier(secret, generation).verify({ ...envelope,
      request: { ...envelope.request, jobId: "ashby:other:123" } })).toThrow("authentication");
    expect(() => new OwnerRequestVerifier(randomBytes(32), generation).verify(envelope)).toThrow("authentication");
    expect(() => new OwnerRequestVerifier(secret, randomUUID()).verify(envelope)).toThrow("authentication");
  });

  it("rejects unsafe URLs, extra fields, invalid secrets, and oversized messages", () => {
    const secret = randomBytes(32);
    expect(() => signOwnerRequest({ ...inspect(), officialUrl: "http://localhost/123" }, secret)).toThrow();
    expect(() => signOwnerRequest({ ...inspect(), officialUrl: "https://user:pass@jobs.example.test/123" }, secret)).toThrow();
    expect(() => signOwnerRequest({ ...inspect(), extra: "unexpected" } as ReturnType<typeof inspect>, secret)).toThrow();
    expect(() => signOwnerRequest(inspect(), Buffer.alloc(16))).toThrow("32 bytes");
    const verifier = new OwnerRequestVerifier(secret, generation);
    expect(() => verifier.verify({ request: inspect(), mac: "0".repeat(64),
      padding: "x".repeat(20_000) })).toThrow("Invalid browser-owner protocol message");
  });

  it("accepts a minimal authenticated ping without exposing the secret", () => {
    const secret = randomBytes(32);
    const request = { version: 1 as const, action: "ping" as const, requestId: randomUUID(), generation };
    const envelope = signOwnerRequest(request, secret);
    expect(JSON.stringify(envelope)).not.toContain(secret.toString("hex"));
    expect(new OwnerRequestVerifier(secret, generation).verify(envelope)).toEqual(request);
  });
});
