import type { OfficialJobIdentity } from "./durable-journal.js";

/** A pre-submit stop with no question text in Error.message or logs. The
 * storage snapshot must be encrypted promptly and cleared by its owner. */
export class HostedSubmissionBlocked extends Error {
  readonly name = "HostedSubmissionBlocked";
  constructor(readonly details: {
    blockerCodes: readonly string[];
    formUrl: string;
    browserState: Uint8Array;
    resumeSha256: string;
    job: OfficialJobIdentity;
  }) {
    super("Hosted application requires job seeker review");
    if (!Array.isArray(details.blockerCodes) || details.blockerCodes.length < 1
      || details.blockerCodes.length > 25
      || details.blockerCodes.some(code => !/^[a-z][a-z0-9-]{0,79}$/.test(code))
      || details.browserState.byteLength > 512_000
      || !/^[a-f0-9]{64}$/.test(details.resumeSha256)) {
      throw new Error("Hosted handoff metadata is invalid");
    }
  }
  get blockerCodes() { return this.details.blockerCodes; }
  get formUrl() { return this.details.formUrl; }
  get browserState() { return this.details.browserState; }
  get resumeSha256() { return this.details.resumeSha256; }
  get job() { return this.details.job; }
}
