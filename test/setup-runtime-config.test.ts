import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSetupUi } from "../src/setup/ui.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

const fenced = (tag: string, value: unknown) => `\u0060\u0060\u0060${tag}\n${JSON.stringify(value)}\n\u0060\u0060\u0060\n`;

describe("private first-run runtime setup", () => {
  it("creates one validated source and queue config only after current compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-runtime-setup-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const privateRoot = join(root, "private");
    await ensurePrivateDirectory(privateRoot);
    const destination = join(privateRoot, "onboarding");
    const ui = await startSetupUi({ destination, repositoryRoot: process.cwd() });
    try {
      const url = new URL(ui.url), token = url.searchParams.get("token")!;
      const headers = { origin: url.origin, "x-openapply-token": token,
        "content-type": "application/json" };
      const endpoint = `${url.origin}/api/runtime-setup`;
      const post = (value: unknown, overrides: Record<string, string> = {}) => fetch(endpoint, {
        method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(value),
      });
      const request = { browserRuntime: "owned", overleafProjectUrl:
        "https://www.overleaf.com/project/0123456789abcdef01234567",
      dailyTarget: 2, dailyHardCap: 3, requireFinalApproval: true,
      firstSource: { provider: "greenhouse", company: "Fixture", identifier: "fixture" } };
      expect((await post(request)).status).toBe(409);
      expect((await post(request, { origin: "https://attacker.example" })).status).toBe(403);
      expect((await fetch(endpoint)).status).toBe(403);

      await writeFile(join(destination, "01-candidate-profile.md"), fenced("openapply-identity-json", {
        version: 1, identity: { fullName: "Fixture Candidate", location: "Dallas, TX",
          email: "candidate@example.invalid", phone: "555-0100" },
        authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
        education: [],
      }), { mode: 0o600 });
      await writeFile(join(destination, "02-work-history.md"), fenced("openapply-history-json", {
        version: 1, skills: { languages: ["Python"] }, experience: [{
          employer: "Fixture", title: "Engineer", employmentType: "Intern", start: "2025", end: "2026",
          claims: [{ id: "claim-1", claim: "Built Python services", skills: ["Python"],
            evidence: [{ source: "fixture", uri: "private:history" }], status: "user-confirmed",
            allowedUses: ["matching", "resume"] }],
        }], projects: [], quarantinedClaims: [],
      }), { mode: 0o600 });
      await writeFile(join(destination, "03-search-preferences.md"), fenced("openapply-search-json", {
        version: 1, targetRoles: ["Software Engineer"],
        workArrangements: { preferred: ["Remote"], accepted: ["Remote"] },
        compensation: { preferredBaseFloor: 0 },
        applicationPolicy: { dailyTarget: 2, dailyHardCap: 3, requireFinalApproval: true },
      }), { mode: 0o600 });
      expect((await fetch(`${url.origin}/api/compile`, { method: "POST", headers })).status).toBe(200);
      expect((await post({ ...request, dailyHardCap: 4 })).status).toBe(400);
      expect((await post({ ...request,
        overleafProjectUrl: "https://evil.example/project/0123456789abcdef01234567" })).status).toBe(400);
      expect((await post({ ...request, browserRuntime: "browseros",
        browserEndpoint: "https://remote.example/mcp" })).status).toBe(400);
      expect((await post({ ...request, firstSource: { ...request.firstSource,
        identifier: "https://evil.example/board" } })).status).toBe(400);
      const saved = await post(request);
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain(privateRoot);
      const queuePath = join(privateRoot, "queue-runner.json");
      const config = JSON.parse(await readFile(queuePath, "utf8"));
      const discovery = JSON.parse(await readFile(config.discoveryInputPath, "utf8"));
      expect(config.browserRuntime).toBe("owned");
      expect(config.candidatePath).toBe(join(destination, "candidate-profile.json"));
      expect(discovery.sources).toEqual([expect.objectContaining({
        provider: "greenhouse", boardToken: "fixture", company: "Fixture",
        allowedApplicationHosts: ["boards.greenhouse.io", "job-boards.greenhouse.io"],
      })]);
      expect(discovery.includeKeywords).toEqual(["Software Engineer"]);
      const runtimeStatus = await fetch(endpoint, { headers });
      expect(await runtimeStatus.clone().text()).not.toContain(privateRoot);
      expect((await runtimeStatus.json()))
        .toEqual({ configured: true, policy: expect.objectContaining({ dailyTarget: 2, dailyHardCap: 3 }) });
      expect((await post({ ...request, firstSource: { ...request.firstSource,
        identifier: "other" } })).status).toBe(400);
      expect(JSON.parse(await readFile(queuePath, "utf8")).discoveryInputPath).toBe(config.discoveryInputPath);
      expect(JSON.parse(await readFile(config.discoveryInputPath, "utf8")).sources[0].boardToken)
        .toBe("fixture");
      if (process.platform !== "win32") expect((await stat(queuePath)).mode & 0o077).toBe(0);
    } finally { await ui.close(); await rm(root, { recursive: true, force: true }); }
  }, 120_000);
});
