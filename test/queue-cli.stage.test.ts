import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";
import type { ApplicationPackage } from "../src/application/runner.js";
import type { ApplicationWorkflow } from "../src/application/state-machine.js";

const stage = vi.hoisted(() => ({
  home: "",
  secrets: new Map<string, string>(),
  render: vi.fn(),
  runPackage: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, userInfo: () => ({ ...original.userInfo(), homedir: stage.home }) };
});
vi.mock("../src/storage/native-secret-store.js", () => ({
  stateKeyReference: () => "keychain://application-state/main",
  createNativeSecretStore: () => ({
    get: async (reference: string) => stage.secrets.get(reference),
    put: async (reference: string, value: string) => { stage.secrets.set(reference, value); },
    delete: async (reference: string) => { stage.secrets.delete(reference); },
  }),
}));
vi.mock("../src/resume/owned-overleaf.js", () => ({
  renderOwnedOverleafResume: stage.render,
}));
vi.mock("../src/application/runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/application/runner.js")>(),
  runApplicationPackage: stage.runPackage,
}));

let stageRoot: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  stage.render.mockReset();
  stage.runPackage.mockReset();
  stage.secrets.clear();
  if (stageRoot) await rm(stageRoot, { recursive: true, force: true });
  stageRoot = undefined;
});

it("runs the production queue CLI into an encrypted handoff and replays it once after restart", async () => {
  stageRoot = await mkdtemp(join(tmpdir(), "openapply-queue-cli-stage-"));
  stage.home = join(stageRoot, "synthetic-home");
  const privateRoot = join(stage.home, ".openapply-agent");
  const artifacts = join(stageRoot, "artifacts");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { mode: 0o700 });
  if (process.platform === "win32") {
    for (const path of [stageRoot, stage.home, privateRoot, artifacts]) {
      await secureWindowsPrivatePath(path);
    }
  }
  stage.secrets.set("keychain://openapply/staging-resend", "synthetic-api-key");
  const job = {
    id: "ashby:synthetic:123", provider: "ashby", company: "Example Co", title: "Software Engineer",
    location: "Remote", department: "Engineering", employmentType: "Full time",
    workplaceType: "Remote", compensation: null,
    descriptionText: "Build TypeScript services for early career engineers.",
    applicationUrl: "https://example.invalid/apply", sourceUrl: "https://example.invalid/jobs/123",
    sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: "2026-11-26T00:00:00Z",
    discoveredAt: "2026-11-26T00:00:00Z", isNew: true, isFresh: true,
    freshnessBasis: "first-seen", matchedKeywords: [],
  };
  const source = { provider: "ashby", boardName: "synthetic", company: "Example Co",
    enabled: true, allowedApplicationHosts: ["example.invalid"] };
  const candidate = { version: 1,
    identity: { fullName: "Example Candidate", location: "Example City, TX",
      email: "candidate@example.invalid", phone: "+1 555 555 0100" },
    authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
    skills: { languages: ["TypeScript"] }, education: [], projects: [], quarantinedClaims: [],
    experience: [{ employer: "Example Co", title: "Engineer", employmentType: "Intern",
      start: "2025", end: "2025", claims: [{ id: "synthetic-claim",
        claim: "Built TypeScript services", skills: ["TypeScript"],
        evidence: [{ source: "user-confirmed", uri: "private:synthetic" }],
        status: "user-confirmed", allowedUses: ["matching", "resume"] }] }],
  };
  const paths = {
    queuePath: join(stageRoot, "queue.json"), candidatePath: join(stageRoot, "candidate.json"),
    preferencesPath: join(stageRoot, "preferences.json"),
    discoveryInputPath: join(stageRoot, "discovery.json"),
    discoveryStatePath: join(stageRoot, "discovery-state.json"),
    notificationConfigPath: join(stageRoot, "notification.json"),
  };
  const files: Array<[string, unknown]> = [
    [paths.queuePath, { queue: [{ job, source, sourceVerification: "verified" }] }],
    [paths.candidatePath, candidate],
    [paths.preferencesPath, { version: 1, targetRoles: ["software engineer"],
      workArrangements: { preferred: ["remote"], accepted: [] },
      compensation: { preferredBaseFloor: 0 },
      applicationPolicy: { dailyTarget: 1, dailyHardCap: 1, requireFinalApproval: false } }],
    [paths.discoveryInputPath, { sources: [source], preferredFreshnessHours: 48,
      maximumFreshnessHours: 168 }],
    [paths.notificationConfigPath, { version: 1, email: { provider: "resend",
      from: "alerts@example.invalid", to: "candidate@example.invalid",
      apiKeySecretRef: "keychain://openapply/staging-resend" } }],
  ];
  for (const [path, value] of files) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
  }
  const configPath = join(stageRoot, "queue-config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, ...paths,
    browserRuntime: "owned", overleafProjectUrl: "https://www.overleaf.com/project/000000000000000000000000",
    outputDirectory: artifacts, expectedConfirmationByDomain: {} }), { mode: 0o600 });
  if (process.platform === "win32") await secureWindowsPrivatePath(configPath);
  vi.stubEnv("OPENAPPLY_QUEUE_CONFIG", configPath);
  stage.render.mockResolvedValue({ path: join(artifacts, "synthetic.pdf"), pages: 1,
    pdfSha256: "a".repeat(64), verifiedAt: "2026-11-26T00:00:00Z" });
  stage.runPackage.mockImplementation(async (pkg: ApplicationPackage, workflow: ApplicationWorkflow) => {
    await workflow.create(pkg.job.id, pkg.job.applicationUrl);
    for (const step of ["validated", "matched", "tailored"] as const) await workflow.advance(pkg.job.id, step);
    await workflow.advance(pkg.job.id, "rendered", { artifactPath: pkg.resumePdfPath,
      artifactSha256: "a".repeat(64), sourceFingerprint: pkg.resumeSource.fingerprint });
    await workflow.advance(pkg.job.id, "applying");
    const checkpoint = await workflow.advance(pkg.job.id, "waiting-human", {
      blocker: "Synthetic unknown question; no employer site opened",
    });
    return { checkpoint, artifact: { path: pkg.resumePdfPath } };
  });
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response('{"id":"synthetic"}', { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});

  await import("../src/application/queue-cli.js");
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).outcomes)
    .toEqual([{ jobId: job.id, status: "waiting-human" }]);
  expect(stage.render).toHaveBeenCalledOnce();
  expect(stage.runPackage).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
  const [endpoint, request] = fetcher.mock.calls[0]!;
  expect(endpoint).toBe("https://api.resend.com/emails");
  expect(String(request?.body)).not.toContain(job.id);
  expect(String(request?.body)).not.toContain(job.applicationUrl);
  const encryptedPath = join(privateRoot, "applications.enc.json");
  expect(await readFile(encryptedPath, "utf8")).not.toContain(job.applicationUrl);

  // A crashed worker leaves a lease; replay must wait for explicit lease recovery.
  vi.resetModules();
  await expect(import("../src/application/queue-cli.js"))
    .rejects.toThrow("Another workflow is active");
  await rmdir(join(privateRoot, "workflow.lock"));
  vi.resetModules();
  await import("../src/application/queue-cli.js");
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).outcomes).toEqual([]);
  expect(stage.runPackage).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
}, process.platform === "win32" ? 120_000 : 30_000);
