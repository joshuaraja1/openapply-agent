import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGeneratedArtifactControl } from "../src/setup/generated-artifacts.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openapply-artifacts-"));
  if (process.platform === "win32") await secureWindowsPrivatePath(root);
  const artifacts = join(root, "artifacts");
  await ensurePrivateDirectory(artifacts);
  const resume = `${"a".repeat(16)}-${randomUUID()}.pdf`;
  const application = `application-${randomUUID()}.json`;
  const files = [{ name: resume, bytes: Buffer.from("%PDF-1.4\nsynthetic generated resume") },
    { name: application, bytes: Buffer.from('{"job":"synthetic"}') }];
  for (const file of files) {
    const path = join(artifacts, file.name);
    await writeFile(path, file.bytes, { mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(path);
  }
  return { root, artifacts, files };
}

describe("generated artifact controls", () => {
  it("exports, detects a changed PDF, quarantines, protects newer files, restores and purges", async () => {
    const { root, artifacts, files } = await fixture();
    try {
      await expect(runGeneratedArtifactControl("export-artifacts", root))
        .resolves.toEqual({ action: "artifacts-exported", files: 2 });
      expect(await readFile(join(root, "artifact-export", files[0]!.name))).toEqual(files[0]!.bytes);
      await writeFile(join(artifacts, files[0]!.name), "changed");
      await expect(runGeneratedArtifactControl("quarantine-artifacts", root))
        .rejects.toThrow("changed since export");
      expect(await readFile(join(artifacts, files[0]!.name), "utf8")).toBe("changed");
      await writeFile(join(artifacts, files[0]!.name), files[0]!.bytes);
      await writeFile(join(root, "artifact-export", files[0]!.name), "changed backup");
      await expect(runGeneratedArtifactControl("quarantine-artifacts", root))
        .rejects.toThrow("changed since export");
      await writeFile(join(root, "artifact-export", files[0]!.name), files[0]!.bytes);
      await expect(runGeneratedArtifactControl("quarantine-artifacts", root))
        .resolves.toEqual({ action: "artifacts-quarantined", files: 2 });
      await expect(lstat(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(root, "removed-artifacts", "unrelated.txt"), "do not delete", { mode: 0o600 });
      await expect(runGeneratedArtifactControl("purge-artifacts", root))
        .rejects.toThrow("unrecognized entry");
      await rm(join(root, "removed-artifacts", "unrelated.txt"));
      await mkdir(artifacts, { mode: 0o700 });
      await expect(runGeneratedArtifactControl("restore-artifacts", root))
        .rejects.toThrow("Newer generated artifacts");
      await expect(runGeneratedArtifactControl("purge-artifacts", root))
        .rejects.toThrow("Newer generated artifacts");
      await rm(artifacts, { recursive: true });
      await expect(runGeneratedArtifactControl("restore-artifacts", root))
        .resolves.toEqual({ action: "artifacts-restored", files: 2 });
      expect(await readFile(join(artifacts, files[0]!.name))).toEqual(files[0]!.bytes);
      await runGeneratedArtifactControl("quarantine-artifacts", root);
      await expect(runGeneratedArtifactControl("purge-artifacts", root))
        .resolves.toEqual({ action: "artifacts-purged", files: 2 });
      for (const path of ["artifact-export", "removed-artifacts"]) {
        await expect(lstat(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses unrelated names and links in the default artifact directory", async () => {
    const { root, artifacts } = await fixture();
    try {
      await writeFile(join(artifacts, "master-resume.pdf"), "user document", { mode: 0o600 });
      await expect(runGeneratedArtifactControl("export-artifacts", root))
        .rejects.toThrow("unrecognized entry");
      await rm(join(artifacts, "master-resume.pdf"));
      if (process.platform !== "win32") {
        await symlink("/etc/hosts", join(artifacts, `${"b".repeat(16)}-${randomUUID()}.pdf`));
        await expect(runGeneratedArtifactControl("export-artifacts", root))
          .rejects.toThrow();
      }
      await expect(lstat(join(root, "artifact-export"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("can finish a purge after one archived file was already removed", async () => {
    const { root, files } = await fixture();
    try {
      await runGeneratedArtifactControl("export-artifacts", root);
      await runGeneratedArtifactControl("quarantine-artifacts", root);
      await rm(join(root, "removed-artifacts", files[0]!.name));
      await expect(runGeneratedArtifactControl("purge-artifacts", root))
        .resolves.toEqual({ action: "artifacts-purged", files: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
