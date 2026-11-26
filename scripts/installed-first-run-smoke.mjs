import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleAt = (root, path) => import(pathToFileURL(join(root, "dist", "src", path)).href);
const fenced = (tag, value) => `\u0060\u0060\u0060${tag}\n${JSON.stringify(value)}\n\u0060\u0060\u0060\n`;

/** Exercise packed code from a foreign CWD with only synthetic, disposable state. */
export async function smokeInstalledFirstRun(installed, root, cwd) {
  const cli = join(installed, "dist", "src", "product-cli.js");
  const privateRoot = join(root, "first-run-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const { secureWindowsPrivatePath } = await moduleAt(installed, "storage/windows-acl.js");
  const secure = async (path) => {
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
  };
  if (process.platform === "win32") {
    await secure(root);
    await secure(privateRoot);
  }
  const run = (command, variables = {}) => {
    const result = spawnSync(process.execPath, [cli, command], {
      cwd, encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { ...process.env, ...variables },
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const writePrivate = async (path, value) => {
    await writeFile(path, value, { mode: 0o600 });
    await secure(path);
  };

  const onboarding = join(privateRoot, "onboarding");
  const created = JSON.parse(run("setup:init", { OPENAPPLY_SETUP_DIR: onboarding }));
  assert.equal(created.created.length, 8);
  const identity = { version: 1, identity: { fullName: "Synthetic Candidate",
    location: "Dallas, TX", email: "candidate@example.invalid", phone: "555-0100" },
  authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false }, education: [] };
  const history = { version: 1, skills: { languages: ["Python"] }, experience: [{
    employer: "Fixture Employer", title: "Engineer", employmentType: "Intern",
    start: "2025", end: "2026", claims: [{ id: "claim-1",
      claim: "Built Python services for a fixture team", skills: ["Python"],
      evidence: [{ source: "fixture", uri: "private:synthetic-history" }],
      status: "user-confirmed", allowedUses: ["matching", "resume"] }],
  }], projects: [], quarantinedClaims: [] };
  const preferences = { version: 1, targetRoles: ["Software Engineer"],
    workArrangements: { preferred: ["Remote"], accepted: ["Remote", "Hybrid"] },
    compensation: { preferredBaseFloor: 0, targetRangePosition: 0.7 },
    applicationPolicy: { dailyTarget: 1, dailyHardCap: 1, requireFinalApproval: true } };
  await writePrivate(join(onboarding, "01-candidate-profile.md"), fenced("openapply-identity-json", identity));
  await writePrivate(join(onboarding, "02-work-history.md"), fenced("openapply-history-json", history));
  await writePrivate(join(onboarding, "03-search-preferences.md"), fenced("openapply-search-json", preferences));
  const candidateOutput = join(onboarding, "candidate-profile.json");
  const preferencesOutput = join(onboarding, "search-preferences.json");
  run("profile:compile", { OPENAPPLY_PROFILE_MD: join(onboarding, "01-candidate-profile.md"),
    OPENAPPLY_WORK_MD: join(onboarding, "02-work-history.md"),
    OPENAPPLY_SEARCH_MD: join(onboarding, "03-search-preferences.md"),
    OPENAPPLY_PROFILE_OUTPUT: candidateOutput, OPENAPPLY_PREFERENCES_OUTPUT: preferencesOutput });
  assert.equal(JSON.parse(await readFile(candidateOutput, "utf8")).identity.fullName, "Synthetic Candidate");
  assert.equal(JSON.parse(await readFile(preferencesOutput, "utf8")).applicationPolicy.dailyHardCap, 1);
  assert.deepEqual(JSON.parse(run("setup:init", { OPENAPPLY_SETUP_DIR: onboarding })).created, []);
  if (process.platform !== "win32") assert.equal((await stat(candidateOutput)).mode & 0o077, 0);

  const { startSetupUi } = await moduleAt(installed, "setup/ui.js");
  const setup = await startSetupUi({ destination: onboarding, repositoryRoot: installed });
  try {
    const url = new URL(setup.url);
    const headers = { "x-openapply-token": url.searchParams.get("token") };
    const response = await fetch(`${url.origin}/api/readiness`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { valid: true, compiled: true, current: true });
    assert.equal((await fetch(`${url.origin}/api/readiness`)).status, 403);
  } finally { await setup.close(); }

  const { startHandoffUi } = await moduleAt(installed, "application/handoff-ui.js");
  let checkpoint = { jobId: "fixture:1", officialUrl: "https://jobs.example.invalid/1",
    stage: "waiting-human", blocker: "Synthetic required answer", packagePath: join(privateRoot, "package.json"),
    updatedAt: "2026-01-01T00:00:00.000Z" };
  let continued = false;
  const handoff = await startHandoffUi({ jobId: checkpoint.jobId,
    jobLabel: "Fixture Employer — Engineer", loadCheckpoint: async () => checkpoint,
    resume: async (_saved, answers) => {
      assert.deepEqual(answers, [{ field: "Synthetic required answer", value: "Fixture answer" }]);
      continued = true;
      checkpoint = { ...checkpoint, stage: "submitted" };
    } });
  try {
    const url = new URL(handoff.url), token = url.searchParams.get("token");
    const headers = { origin: url.origin, "x-openapply-token": token,
      "content-type": "application/json" };
    assert.equal((await fetch(`${url.origin}/api/handoff`)).status, 403);
    const current = await fetch(`${url.origin}/api/handoff`, { headers });
    assert.equal((await current.json()).stage, "waiting-human");
    const response = await fetch(`${url.origin}/api/resume`, { method: "POST", headers,
      body: JSON.stringify({ updatedAt: checkpoint.updatedAt, authorizeContinuation: true,
        answers: [{ field: "Synthetic required answer", value: "Fixture answer" }] }) });
    assert.equal(response.status, 202);
    for (let attempt = 0; !continued && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(continued, true);
    assert.equal((await fetch(`${url.origin}/api/handoff`, { headers }).then((value) => value.json())).stage,
      "submitted");
  } finally { await handoff.close(); }

  const { ensurePrivateDirectory } = await moduleAt(installed, "storage/private-path.js");
  const stateDir = join(privateRoot, "state");
  await ensurePrivateDirectory(stateDir);
  const key = randomBytes(32);
  const { EncryptedApplicationStateStore } = await moduleAt(installed, "storage/encrypted-state.js");
  const store = new EncryptedApplicationStateStore(join(stateDir, "applications.enc.json"), key);
  await store.compareAndSwap("fixture:1", undefined, checkpoint);
  const paths = { encryptedDirectory: stateDir, databasePath: join(stateDir, "state.sqlite"),
    discoveryStatePath: join(stateDir, "discovery.json"), queuePath: join(stateDir, "queue.json") };
  await writePrivate(paths.discoveryStatePath, JSON.stringify({ jobs: {} }));
  await writePrivate(paths.queuePath, JSON.stringify({ queue: [] }));
  const { exportLocalState, quarantineLocalState, restoreLocalState, purgeLocalStateArchive } =
    await moduleAt(installed, "storage/data-controls.js");
  const exportPath = join(privateRoot, "export.json"), archivePath = join(privateRoot, "archive");
  const exported = await exportLocalState(paths, key, exportPath);
  assert.equal(exported.records.applications[0].state.jobId, "fixture:1");
  assert.equal(await quarantineLocalState(paths, key, exportPath, archivePath, true), 3);
  assert.equal(await store.read("fixture:1"), undefined);
  assert.equal(await restoreLocalState(paths, archivePath, true), 3);
  assert.equal((await store.read("fixture:1")).state.jobId, "fixture:1");
  assert.equal(await quarantineLocalState(paths, key, exportPath, archivePath, true), 3);
  await purgeLocalStateArchive(paths, archivePath, true, true);
  assert.equal(await store.read("fixture:1"), undefined);
  await assert.rejects(stat(archivePath), { code: "ENOENT" });
  console.log("Packed first-run setup, handoff, export/delete/restore smoke passed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await smokeInstalledFirstRun(process.argv[2], process.argv[3], process.argv[4]);
}
