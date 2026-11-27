import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyntheticBrowserApplication, SyntheticReceiptVerifier }
  from "./synthetic-browser-application.js";

/** Image-level diagnostic using disposable data and no AWS or employer site. */
export async function runSyntheticBrowserFixture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openapply-image-fixture-"));
  const candidateId = "00000000-0000-4000-8000-000000000001";
  const job = { provider: "synthetic", employerId: "fixture", requisitionId: "image-1" };
  const profilePath = join(root, "profile.json");
  let prepared: Awaited<ReturnType<SyntheticBrowserApplication["prepare"]>> | undefined;
  try {
    await writeFile(profilePath, JSON.stringify({ version: 1,
      provenance: "candidate-entered-and-reviewed", candidateId,
      workAuthorization: "Fixture authorized", sponsorshipRequiredNowOrFuture: false,
      consent: { storage: true, automation: true, reviewed: true } }), { mode: 0o600 });
    prepared = await new SyntheticBrowserApplication().prepare(profilePath, job, candidateId);
    const receipt = await prepared.submitOnce();
    if (!receipt || !await new SyntheticReceiptVerifier().verify(receipt, job)) {
      throw new Error("Synthetic image receipt was not verified");
    }
    process.stdout.write("Cloud browser fixture passed\n");
  } finally {
    try { await prepared?.close?.(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
