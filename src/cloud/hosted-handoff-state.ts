import { officialJobKey, type OfficialJobIdentity } from "./durable-journal.js";

const MAX_STATE_BYTES = 512_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Sensitive browser state belongs only in a CandidateVault handoff object. */
export interface HostedHandoffState {
  version: 1;
  candidateId: string;
  runId: string;
  job: OfficialJobIdentity;
  formUrl: string;
  resumeSha256: string;
  capturedAt: string;
  blockerCodes: string[];
  browserState: { cookies: unknown[]; origins: unknown[] };
}

function officialOrigin(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || parsed.hash || !parsed.hostname) throw new Error("Handoff form URL is unsafe");
  return parsed;
}

function verifyBrowserState(value: HostedHandoffState["browserState"], host: string): void {
  if (!value || !Array.isArray(value.cookies) || !Array.isArray(value.origins)
    || value.cookies.length > 200 || value.origins.length > 5) {
    throw new Error("Handoff browser state is invalid");
  }
  for (const item of value.cookies) {
    if (!item || typeof item !== "object") throw new Error("Handoff cookie is invalid");
    const cookie = item as Record<string, unknown>;
    if (typeof cookie.domain !== "string"
      || cookie.domain.replace(/^\./, "").toLowerCase() !== host
      || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
      throw new Error("Handoff cookie is outside the employer host");
    }
  }
  for (const item of value.origins) {
    if (!item || typeof item !== "object") throw new Error("Handoff origin is invalid");
    const origin = item as Record<string, unknown>;
    if (typeof origin.origin !== "string" || officialOrigin(origin.origin).origin !== `https://${host}`
      || !Array.isArray(origin.localStorage) || origin.localStorage.length > 500) {
      throw new Error("Handoff origin is outside the employer host");
    }
  }
}

/** The caller must zero this buffer after encrypting it. */
export function encodeHostedHandoff(state: HostedHandoffState): Buffer {
  if (state.version !== 1 || !UUID.test(state.candidateId) || !UUID.test(state.runId)
    || !/^[a-f0-9]{64}$/.test(state.resumeSha256)
    || !Array.isArray(state.blockerCodes) || state.blockerCodes.length > 25
    || state.blockerCodes.some(code => !/^[a-z][a-z0-9-]{0,79}$/.test(code))
    || !Number.isFinite(Date.parse(state.capturedAt))) {
    throw new Error("Handoff metadata is invalid");
  }
  officialJobKey(state.job);
  const url = officialOrigin(state.formUrl);
  verifyBrowserState(state.browserState, url.hostname.toLowerCase());
  const bytes = Buffer.from(JSON.stringify(state), "utf8");
  if (bytes.byteLength > MAX_STATE_BYTES) { bytes.fill(0); throw new Error("Handoff state is oversized"); }
  return bytes;
}

/** Validates exact run and job before a new task may restore the session. */
export function decodeHostedHandoff(bytes: Uint8Array, expected: {
  candidateId: string; runId: string; job: OfficialJobIdentity; employerHost: string;
}, now = new Date()): HostedHandoffState {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STATE_BYTES) {
    throw new Error("Handoff state is unavailable");
  }
  let value: HostedHandoffState;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as HostedHandoffState; }
  catch { throw new Error("Handoff state is unavailable"); }
  // Round-trip through the encoder to apply all structure and host checks.
  const encoded = encodeHostedHandoff(value);
  encoded.fill(0);
  const captured = Date.parse(value.capturedAt);
  if (value.candidateId !== expected.candidateId || value.runId !== expected.runId
    || officialJobKey(value.job) !== officialJobKey(expected.job)
    || officialOrigin(value.formUrl).hostname.toLowerCase() !== expected.employerHost.toLowerCase()
    || captured > now.getTime() + 30_000 || now.getTime() - captured > MAX_AGE_MS) {
    throw new Error("Handoff state does not match the authorized run");
  }
  return value;
}
