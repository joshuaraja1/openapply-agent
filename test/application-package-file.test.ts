import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readApplicationPackage, writeApplicationPackage } from "../src/application/package-file.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath, assertWindowsPrivatePath } from "../src/storage/windows-acl.js";
import { applicationPackageSchema } from "../src/application/runner.js";

const url = "https://jobs.example.com/apply/123456";
const pkg = applicationPackageSchema.parse({
  version: 1,
  browserRuntime: "owned",
  job: { id: "greenhouse:example:123456", provider: "greenhouse", company: "Example Co",
    title: "Engineer", descriptionText: "Python", applicationUrl: url, sourceUrl: url,
    location: null, department: null, employmentType: null, workplaceType: null,
    compensation: null, sourcePublishedAt: null, sourceUpdatedAt: null,
    firstSeenAt: "2026-11-24T00:00:00Z", discoveredAt: "2026-11-24T00:00:00Z",
    isNew: true, isFresh: true, freshnessBasis: "first-seen", matchedKeywords: [] },
  source: { provider: "greenhouse", company: "Example Co", boardToken: "example",
    allowedApplicationHosts: ["jobs.example.com"] },
  candidate: { version: 1,
    identity: { fullName: "Test Candidate", location: "Dallas, TX", email: "test@example.com", phone: "555-0100" },
    authorization: { countries: ["United States"], sponsorshipRequiredNowOrFuture: false },
    skills: {}, education: [], experience: [], projects: [] },
  handoff: { version: 1, jobId: "greenhouse:example:123456", applicationUrl: url,
    mode: "prepare", allowedDomains: ["jobs.example.com"], requiredArtifacts: ["resume"],
    stopConditions: ["final-submit"] },
  resumeSource: { latex: "fixture", fingerprint: "f".repeat(64), renderToken: "a".repeat(64), claimIds: ["x"] },
  resumePdfPath: "/private/resume.pdf",
});

describe("private application package storage", () => {
  it("writes owner-only data and rejects a shared package on read or overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "openapply-package-"));
    const directory = join(root, "private");
    const path = join(directory, "application.json");
    try {
      if (process.platform === "win32") await secureWindowsPrivatePath(root);
      await ensurePrivateDirectory(directory);
      await writeApplicationPackage(path, pkg);
      expect(await readApplicationPackage(path)).toEqual(pkg);
      await writeApplicationPackage(path, pkg);
      if (process.platform === "win32") {
        await assertWindowsPrivatePath(path);
        execFileSync("icacls", [path, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      } else {
        expect((await lstat(path)).mode & 0o077).toBe(0);
        await chmod(path, 0o644);
      }
      await expect(readApplicationPackage(path)).rejects.toThrow();
      await expect(writeApplicationPackage(path, pkg)).rejects.toThrow();
      if (process.platform === "win32") await secureWindowsPrivatePath(path);
      else await chmod(path, 0o600);
      await writeFile(path, '{"candidate":"private@example.com"');
      await expect(readApplicationPackage(path)).rejects.toThrow("Private application package is invalid");
    } finally {
      if (process.platform === "win32") await secureWindowsPrivatePath(path).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
