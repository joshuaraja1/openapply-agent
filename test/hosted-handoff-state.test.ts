import { describe, expect, it } from "vitest";
import { decodeHostedHandoff, encodeHostedHandoff, type HostedHandoffState }
  from "../src/cloud/hosted-handoff-state.js";
import { HostedSubmissionBlocked } from "../src/cloud/hosted-submission-blocked.js";

const candidateId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const job = { provider: "greenhouse", employerId: "example", requisitionId: "123" };
const capturedAt = "2026-11-28T04:00:00.000Z";
const state: HostedHandoffState = { version: 1, candidateId, runId, job,
  formUrl: "https://jobs.example.com/apply/123", resumeSha256: "a".repeat(64),
  capturedAt, blockerCodes: ["unknown-required-field"], browserState: {
    cookies: [{ name: "session", value: "private", domain: "jobs.example.com" }],
    origins: [{ origin: "https://jobs.example.com", localStorage: [] }],
  } };
const expected = { candidateId, runId, job, employerHost: "jobs.example.com" };

describe("hosted handoff checkpoint", () => {
  it("round trips an exact job seeker, run, employer and age", () => {
    const bytes = encodeHostedHandoff(state);
    expect(decodeHostedHandoff(bytes, expected, new Date("2026-11-28T04:01:00Z")))
      .toEqual(state);
    bytes.fill(0);
  });
  it("rejects another job, tenant, employer, stale session and cross-host cookies", () => {
    const bytes = encodeHostedHandoff(state);
    expect(() => decodeHostedHandoff(bytes, { ...expected, candidateId: runId })).toThrow();
    expect(() => decodeHostedHandoff(bytes, { ...expected, job: { ...job, requisitionId: "other" } })).toThrow();
    expect(() => decodeHostedHandoff(bytes, { ...expected, employerHost: "evil.example" })).toThrow();
    expect(() => decodeHostedHandoff(bytes, expected, new Date("2026-11-30T04:00:00Z"))).toThrow();
    expect(() => encodeHostedHandoff({ ...state, browserState: { ...state.browserState,
      cookies: [{ name: "x", value: "y", domain: "evil.example" }] } })).toThrow();
    bytes.fill(0);
  });
  it("logs only a generic blocked error, with bounded codes", () => {
    const error = new HostedSubmissionBlocked({ blockerCodes: ["unknown-required-field"],
      formUrl: state.formUrl, browserState: Buffer.from("{}"),
      resumeSha256: state.resumeSha256, job });
    expect(error.message).not.toContain("jobs.example.com");
    expect(error.blockerCodes).toEqual(["unknown-required-field"]);
    expect(() => new HostedSubmissionBlocked({ ...error.details,
      blockerCodes: ["private question text!"] })).toThrow();
  });
});
