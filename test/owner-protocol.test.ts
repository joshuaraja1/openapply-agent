import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOwnerIdentity, OwnerRequestVerifier, signOwnerRequest }
  from "../src/browser/owner-protocol.js";

const hash = "a".repeat(64);
const generation = randomUUID();
const inspect = () => ({ version: 1 as const, action: "inspect-tab" as const,
  requestId: randomUUID(), generation, tabId: randomUUID(), claimId: randomUUID(),
  jobId: "ashby:example:123", officialUrl: "https://jobs.example.test/123",
  packageSha256: hash, artifactSha256: hash });
const binding = (request: ReturnType<typeof inspect>) => ({ tabId: request.tabId,
  claimId: request.claimId, jobId: request.jobId, officialUrl: request.officialUrl,
  packageSha256: request.packageSha256, artifactSha256: request.artifactSha256 });
const raw = (value: unknown) => JSON.stringify(value);

describe("inactive browser-owner request protocol", () => {
  it("accepts a bound inspection once and rejects replay or changed job bindings", () => {
    const secret = randomBytes(32);
    const verifier = new OwnerRequestVerifier(secret, generation);
    const envelope = signOwnerRequest(inspect(), secret);
    const expected = binding(envelope.request as ReturnType<typeof inspect>);
    expect(() => verifier.verify(raw(envelope))).toThrow("active claim");
    expect(verifier.verify(raw(envelope), expected)).toEqual(envelope.request);
    expect(() => verifier.verify(raw(envelope), expected)).toThrow("replay");
    expect(() => new OwnerRequestVerifier(secret, generation).verify(raw(envelope),
      { ...expected, jobId: "ashby:other:123" })).toThrow("active claim");
    const missingArtifact = { ...expected, unrelated: undefined } as unknown as typeof expected;
    delete (missingArtifact as Partial<typeof expected>).artifactSha256;
    expect(() => new OwnerRequestVerifier(secret, generation).verify(raw(envelope),
      missingArtifact)).toThrow("active claim");
    expect(() => new OwnerRequestVerifier(secret, generation).verify(raw({ ...envelope,
      request: { ...envelope.request, jobId: "ashby:other:123" } }), expected)).toThrow("authentication");
    expect(() => new OwnerRequestVerifier(randomBytes(32), generation).verify(raw(envelope), expected)).toThrow("authentication");
    expect(() => new OwnerRequestVerifier(secret, randomUUID()).verify(raw(envelope), expected)).toThrow("authentication");
  });

  it("rejects unsafe URLs, extra fields, invalid secrets, and oversized messages", () => {
    const secret = randomBytes(32);
    expect(() => signOwnerRequest({ ...inspect(), officialUrl: "http://localhost/123" }, secret)).toThrow();
    expect(() => signOwnerRequest({ ...inspect(), officialUrl: "https://user:pass@jobs.example.test/123" }, secret)).toThrow();
    expect(() => signOwnerRequest({ ...inspect(), extra: "unexpected" } as ReturnType<typeof inspect>, secret)).toThrow();
    expect(() => signOwnerRequest(inspect(), Buffer.alloc(16))).toThrow("32 bytes");
    const verifier = new OwnerRequestVerifier(secret, generation);
    expect(() => verifier.verify(raw({ request: inspect(), mac: "0".repeat(64),
      padding: "x".repeat(20_000) }))).toThrow("Invalid browser-owner protocol message");
  });

  it("accepts a minimal authenticated ping without exposing the secret", () => {
    const secret = randomBytes(32);
    const request = { version: 1 as const, action: "ping" as const, requestId: randomUUID(), generation };
    const envelope = signOwnerRequest(request, secret);
    expect(JSON.stringify(envelope)).not.toContain(secret.toString("hex"));
    expect(new OwnerRequestVerifier(secret, generation).verify(raw(envelope))).toEqual(request);
    const restarted = createOwnerIdentity();
    expect(restarted.generation).not.toBe(generation);
    expect(restarted.secret).not.toEqual(secret);
    expect(() => new OwnerRequestVerifier(restarted.secret, restarted.generation)
      .verify(raw(envelope))).toThrow("authentication");
  });
});
