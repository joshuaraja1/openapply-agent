import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSetupDryRun } from "../src/setup/dry-run.js";
import { userTemplateFiles } from "../src/setup/init.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("integrated first-run dry run", () => {
  it("reports a private preview only after validated local inputs and a read-only session probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-dry-run-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const destination = join(root, "onboarding");
    const configPath = join(root, "queue.json");
    const save = async (path: string, data: unknown) => {
      await writeFile(path, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
    };
    try {
      await ensurePrivateDirectory(destination);
      for (const name of userTemplateFiles) await save(join(destination, name), "Completed fixture\n");
      await save(join(destination, "candidate-profile.json"), { version: 1,
        identity: { fullName: "Private Candidate", location: "Dallas, TX",
          email: "private@example.invalid", phone: "555-0100" },
        authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
        skills: { languages: ["Python"] }, education: [], experience: [], projects: [] });
      await save(join(destination, "search-preferences.json"), { version: 1,
        targetRoles: ["Software Engineer"], workArrangements: { preferred: ["Remote"], accepted: ["Hybrid"] },
        compensation: { preferredBaseFloor: 90000 },
        applicationPolicy: { dailyTarget: 2, dailyHardCap: 3, requireFinalApproval: true } });
      const sourcePath = join(root, "sources.json");
      await save(sourcePath, { sources: [{ provider: "greenhouse", company: "Fixture",
        boardToken: "fixture", enabled: true }] });
      const overleafProjectUrl = "https://www.overleaf.com/project/0123456789abcdef01234567";
      await save(configPath, { version: 1, queuePath: join(root, "queue-output.json"),
        candidatePath: join(destination, "candidate-profile.json"),
        preferencesPath: join(destination, "search-preferences.json"),
        discoveryInputPath: sourcePath, discoveryStatePath: join(root, "discovery-state.json"),
        browserRuntime: "owned", overleafProjectUrl, outputDirectory: join(root, "artifacts") });
      const doctor = vi.fn(async () => ({ status: "ready" as const, startupMs: 1, browserVersion: "test" }));
      const session = vi.fn(async () => true);
      const input = { destination, queueConfigPath: configPath,
        profile: { valid: true, compiled: true, current: true },
        browserDoctor: doctor, probeOwnedOverleaf: session };
      const ready = await runSetupDryRun(input);
      expect(ready.readyForPrivatePreview).toBe(true);
      expect(ready.readyForLiveApplications).toBe(false);
      expect(ready.checks.every((item) => item.status === "ready")).toBe(true);
      expect(session).toHaveBeenCalledWith(overleafProjectUrl);
      expect(JSON.stringify(ready)).not.toMatch(/Private Candidate|private@example|overleaf\.com|fixture|\/tmp\//);

      await save(join(destination, userTemplateFiles[3]), "{{unfinished}}\n");
      const incomplete = await runSetupDryRun(input);
      expect(incomplete.readyForPrivatePreview).toBe(false);
      expect(incomplete.checks.find((item) => item.id === "templates")?.status).toBe("action-required");
      await save(join(destination, userTemplateFiles[3]), "   \n");
      const blank = await runSetupDryRun(input);
      expect(blank.readyForPrivatePreview).toBe(false);
      expect(blank.checks.find((item) => item.id === "templates")?.status).toBe("action-required");
      await save(join(destination, userTemplateFiles[3]), "A           B\n");
      expect((await runSetupDryRun(input)).checks.find((item) => item.id === "templates")?.status)
        .toBe("action-required");
      await save(join(destination, userTemplateFiles[3]), "Completed fixture\n");
      session.mockResolvedValue(false);
      const signedOut = await runSetupDryRun(input);
      expect(signedOut.checks.find((item) => item.id === "overleaf-session")?.status)
        .toBe("action-required");
      expect(signedOut.checks.find((item) => item.id === "overleaf-session")?.action)
        .toContain("unverified under the restricted check");
      await save(sourcePath, { sources: [{ provider: "greenhouse", company: "Fixture",
        boardToken: "fixture", enabled: false }] });
      doctor.mockClear(); session.mockClear();
      const noSource = await runSetupDryRun(input);
      expect(noSource.checks.find((item) => item.id === "queue-and-sources")?.status)
        .toBe("action-required");
      expect(doctor).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
