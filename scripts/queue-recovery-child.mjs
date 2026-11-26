import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../dist/src/storage/encrypted-state.js";
import { ApplicationWorkflow } from "../dist/src/application/state-machine.js";

const [mode, root] = process.argv.slice(2);
const key = Buffer.from(process.env.OPENAPPLY_BENCHMARK_KEY_HEX ?? "", "hex");
if (!root || key.length !== 32 || !["claim", "recover"].includes(mode)) {
  throw new Error("Invalid synthetic recovery fixture arguments");
}
const id = "synthetic-requisition";
const workflow = new ApplicationWorkflow(
  new EncryptedApplicationStateStore(join(root, "applications.enc.json"), key));
const marker = join(root, "simulated-clicks.txt");

if (mode === "claim") {
  await workflow.create(id, "https://example.invalid/apply");
  for (const stage of ["validated", "matched", "tailored"]) await workflow.advance(id, stage);
  await workflow.advance(id, "rendered", { artifactPath: "/synthetic/resume.pdf",
    artifactSha256: "a".repeat(64), sourceFingerprint: "b".repeat(64) });
  await workflow.advance(id, "applying");
  await workflow.advance(id, "submit-claimed");
  // This marker stands in for a final click. No browser or employer is opened.
  await writeFile(marker, "1", { flag: "wx", mode: 0o600 });
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
} else {
  const checkpoint = await workflow.current(id);
  if (checkpoint?.stage !== "submit-claimed") throw new Error("Durable submit claim was lost");
  const clickCount = Number(await readFile(marker, "utf8"));
  if (clickCount !== 1) throw new Error("Synthetic final click was repeated or lost");
  const uncertain = await workflow.advance(id, "submission-uncertain",
    { blocker: "Process terminated after submit claim; inspect employer confirmation" });
  process.stdout.write(`${JSON.stringify({ stage: uncertain.stage, clickCount })}\n`);
}
