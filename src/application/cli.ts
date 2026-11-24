import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { EncryptedApplicationStateStore } from "../storage/encrypted-state.js";
import { getOrCreateStateKey, MacKeychainSecretStore } from "../storage/mac-keychain.js";
import { applicationPackageSchema, runApplicationPackage } from "./runner.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";

const packagePath = process.env.OPENAPPLY_PACKAGE;
if (!packagePath) throw new Error("Set OPENAPPLY_PACKAGE to a private application package JSON file");
const pkg = applicationPackageSchema.parse(JSON.parse(await readFile(packagePath, "utf8")));
const approvedJobId = process.env.OPENAPPLY_APPROVE_JOB_ID;
if (approvedJobId && approvedJobId !== pkg.job.id) throw new Error("Approval job ID does not match the package");
const authorizedPackage = approvedJobId
  ? { ...pkg, handoff: { ...pkg.handoff, mode: "submit-after-approval" as const,
    stopConditions: pkg.handoff.stopConditions.filter((condition) => condition !== "final-submit") } } : pkg;
const home = join(userInfo().homedir, ".openapply-agent");
const statePath = join(home, "applications.enc.json");
const profileDirectory = join(home, "browser-profile");
const key = await getOrCreateStateKey(new MacKeychainSecretStore(), "keychain://application-state/main");
const store = new EncryptedApplicationStateStore<ApplicationCheckpoint>(statePath, key);
const result = await runApplicationPackage(authorizedPackage, new ApplicationWorkflow(store), profileDirectory,
  approvedJobId ? { approvedJobId } : {});
console.log(JSON.stringify({ jobId: pkg.job.id, stage: result.checkpoint.stage,
  blocker: result.checkpoint.blocker ?? null }));
