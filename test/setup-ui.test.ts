import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { startSetupUi } from "../src/setup/ui.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("local first-run setup", () => {
  it("compiles only valid private structured evidence and preserves existing outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-compile-"));
    const destination = join(root, "onboarding");
    const ui = await startSetupUi({ destination, repositoryRoot: process.cwd() });
    try {
      const url = new URL(ui.url);
      const headers = { "x-openapply-token": url.searchParams.get("token")!, origin: url.origin };
      const readiness = async () => fetch(`${url.origin}/api/readiness`, { headers })
        .then(async (result) => ({ status: result.status, value: await result.json() }));
      expect(await readiness()).toEqual({ status: 200,
        value: { valid: false, compiled: false, current: false } });
      expect((await fetch(`${url.origin}/api/compile`, { method: "POST", headers })).status).toBe(400);
      const fenced = (tag: string, data: unknown) => `\u0060\u0060\u0060${tag}\n${JSON.stringify(data)}\n\u0060\u0060\u0060\n`;
      await writeFile(join(destination, "01-candidate-profile.md"), fenced("openapply-identity-json", {
        version: 1, identity: { fullName: "Test Candidate", location: "Dallas, TX",
          email: "candidate@example.com", phone: "555-0100" },
        authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false }, education: [],
      }));
      await writeFile(join(destination, "02-work-history.md"), fenced("openapply-history-json", {
        version: 1, skills: { languages: ["Python"] },
        experience: [{ employer: "Example", title: "Engineer", employmentType: "Full-time",
          start: "2024", end: "2026", claims: [{ id: "claim-1", claim: "Built Python services",
            skills: ["Python"], evidence: [{ source: "user", uri: "private:history" }],
            status: "user-confirmed", allowedUses: ["resume", "matching"] }] }],
        projects: [], quarantinedClaims: [],
      }));
      await writeFile(join(destination, "03-search-preferences.md"), fenced("openapply-search-json", {
        version: 1, targetRoles: ["Software Engineer"],
        workArrangements: { preferred: ["Remote"], accepted: ["Hybrid"] },
        compensation: { preferredBaseFloor: 100000 },
        applicationPolicy: { dailyTarget: 10, dailyHardCap: 25, requireFinalApproval: true },
      }));
      expect(await readiness()).toEqual({ status: 200,
        value: { valid: true, compiled: false, current: false } });
      const compile = () => fetch(`${url.origin}/api/compile`, { method: "POST", headers });
      expect((await compile()).status).toBe(200);
      expect((await compile()).status).toBe(200);
      expect(await readiness()).toEqual({ status: 200,
        value: { valid: true, compiled: true, current: true } });
      const profileSource = join(destination, "01-candidate-profile.md");
      if (process.platform !== "win32") {
        await chmod(profileSource, 0o644);
        expect((await readiness()).status).toBe(400);
        await chmod(profileSource, 0o600);
      }
      const preview = (title: string, description: string) => fetch(`${url.origin}/api/preview`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      const eligible = await preview("Software Engineer", "Build Python services for early career users");
      expect(eligible.status).toBe(200);
      expect(await eligible.json()).toMatchObject({ previewOnly: true,
        match: { eligible: true, matchedSkills: ["Python"] } });
      const unsupported = await preview("Software Engineer", "Build C++ firmware");
      expect(await unsupported.json()).toMatchObject({ previewOnly: true,
        match: { eligible: false, matchedSkills: [] } });
      expect((await preview("", "Build Python services")).status).toBe(400);
      expect((await fetch(`${url.origin}/api/preview`, { method: "POST",
        headers: { ...headers, origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ title: "Software Engineer", description: "Python" }) })).status).toBe(403);
      const profile = JSON.parse(await readFile(join(destination, "candidate-profile.json"), "utf8")) as
        { identity: { fullName: string } };
      expect(profile.identity.fullName).toBe("Test Candidate");
      const oldSource = await readFile(profileSource, "utf8");
      await writeFile(profileSource, oldSource.replace("Test Candidate", "Changed Candidate"));
      expect(await readiness()).toEqual({ status: 200,
        value: { valid: true, compiled: true, current: false } });
      expect((await compile()).status).toBe(400);
      expect((await readFile(join(destination, "candidate-profile.json"), "utf8"))).toContain("Test Candidate");
      await writeFile(profileSource, "changed");
      expect(await readiness()).toEqual({ status: 200,
        value: { valid: false, compiled: false, current: false } });
    } finally {
      await ui.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves private templates, saves with compare-and-swap, and rejects cross-origin writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-ui-"));
    const ui = await startSetupUi({ destination: join(root, "onboarding"), repositoryRoot: process.cwd() });
    try {
      const url = new URL(ui.url);
      const token = url.searchParams.get("token")!;
      const origin = url.origin;
      const page = await fetch(ui.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain("Try a job match");
      expect(html).toContain("Check readiness");
      expect(html).toContain("Check runtime setup");
      expect(html).toContain("Check browser installation");
      const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeTruthy();
      expect(() => new Script(script!)).not.toThrow();
      expect((await fetch(`${origin}/api/templates`)).status).toBe(403);
      expect((await fetch(`${origin}/api/readiness`)).status).toBe(403);
      expect((await fetch(`${origin}/api/runtime-readiness`)).status).toBe(403);
      expect((await fetch(`${origin}/api/browser-doctor`, { method: "POST" })).status).toBe(403);
      const runtime = await fetch(`${origin}/api/runtime-readiness`, {
        headers: { "x-openapply-token": token },
      });
      expect(await runtime.json()).toMatchObject({ queueConfig: "missing", browser: "missing" });
      const listing = await fetch(`${origin}/api/templates`, { headers: { "x-openapply-token": token } });
      const files = (await listing.json()) as { files: { name: string; content: string; sha256: string }[] };
      expect(files.files).toHaveLength(8);
      const first = files.files[0]!;
      const target = `${origin}/api/template/${first.name}`;
      const update = { content: `${first.content}\nPrivate answer`, expectedSha256: first.sha256 };
      const headers = { "content-type": "application/json", "x-openapply-token": token,
        origin };
      expect((await fetch(target, { method: "PUT", headers: { ...headers, origin: "https://evil.example" },
        body: JSON.stringify(update) })).status).toBe(403);
      expect((await fetch(`${origin}/api/template/../unrelated`, { method: "PUT", headers,
        body: JSON.stringify(update) })).status).toBe(404);
      expect((await fetch(target, { method: "PUT", headers, body: JSON.stringify(update) })).status).toBe(200);
      expect((await fetch(target, { method: "PUT", headers, body: JSON.stringify(update) })).status).toBe(409);
      const path = join(root, "onboarding", first.name);
      expect(await readFile(path, "utf8")).toBe(update.content);
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
    } finally {
      await ui.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the browser doctor only through an authorized local request", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-setup-doctor-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(root);
    const configPath = join(root, "queue-config.json");
    await writeFile(configPath, JSON.stringify({ version: 1, queuePath: join(root, "queue.json"),
      candidatePath: join(root, "onboarding", "candidate-profile.json"),
      preferencesPath: join(root, "onboarding", "search-preferences.json"),
      discoveryInputPath: join(root, "sources.json"), discoveryStatePath: join(root, "state.json"),
      browserRuntime: "owned", overleafProjectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
      outputDirectory: join(root, "artifacts") }), { mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(configPath);
    const doctor = vi.fn(async (_profile: string) => ({ status: "ready" as const,
      startupMs: 1, browserVersion: "test" }));
    const ui = await startSetupUi({ destination: join(root, "onboarding"),
      repositoryRoot: process.cwd(), queueConfigPath: configPath, browserDoctor: doctor });
    try {
      const url = new URL(ui.url), token = url.searchParams.get("token")!;
      const endpoint = `${url.origin}/api/browser-doctor`;
      expect((await fetch(endpoint, { method: "POST", headers: {
        origin: "https://attacker.example", "x-openapply-token": token,
      } })).status).toBe(403);
      expect(doctor).not.toHaveBeenCalled();
      const result = await fetch(endpoint, { method: "POST", headers: {
        origin: url.origin, "x-openapply-token": token,
      } });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ browser: "ready" });
      const profile = doctor.mock.calls[0]![0];
      expect(profile).toContain("openapply-browser-doctor-");
      expect(existsSync(dirname(profile))).toBe(false);
    } finally { await ui.close(); await rm(root, { recursive: true, force: true }); }
  });
});
