import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startSetupUi } from "../src/setup/ui.js";
import { EncryptedApplicationStateStore } from "../src/storage/encrypted-state.js";
import { ensurePrivateDirectory } from "../src/storage/private-path.js";
import { secureWindowsPrivatePath } from "../src/storage/windows-acl.js";

describe("local setup state controls", () => {
  it("requires local authorization and confirmations, then exports, restores, and purges synthetic state", async () => {
    const base = await mkdtemp(join(tmpdir(), "openapply-setup-state-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(base);
    const root = join(base, "state");
    await ensurePrivateDirectory(root);
    const configPath = join(root, "queue-config.json");
    const queuePath = join(root, "queue.json"), discoveryStatePath = join(root, "discovery.json");
    await writeFile(configPath, JSON.stringify({ version: 1, queuePath,
      discoveryStatePath, discoveryInputPath: join(root, "sources.json"),
      candidatePath: join(root, "candidate.json"), preferencesPath: join(root, "preferences.json"),
      browserRuntime: "owned", overleafProjectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
      outputDirectory: join(root, "artifacts") }), { mode: 0o600 });
    await writeFile(queuePath, JSON.stringify({ queue: [] }), { mode: 0o600 });
    await writeFile(discoveryStatePath, JSON.stringify({ jobs: {} }), { mode: 0o600 });
    if (process.platform === "win32") for (const path of [configPath, queuePath, discoveryStatePath]) {
      await secureWindowsPrivatePath(path);
    }
    const key = randomBytes(32);
    const store = new EncryptedApplicationStateStore(join(root, "applications.enc.json"), key);
    await store.compareAndSwap("fixture:1", undefined, { stage: "waiting-human", email: "synthetic@example.com" });
    const ui = await startSetupUi({ destination: join(base, "onboarding"), repositoryRoot: process.cwd(),
      queueConfigPath: configPath, stateRoot: root,
      stateSecretStore: { get: async () => key.toString("base64"), put: async () => {}, delete: async () => {} } });
    try {
      const url = new URL(ui.url), endpoint = `${url.origin}/api/state-control`;
      const headers = { origin: url.origin, "content-type": "application/json",
        "x-openapply-token": url.searchParams.get("token")! };
      const post = (action: string, confirmation: string, override = {}) => fetch(endpoint, {
        method: "POST", headers: { ...headers, ...override }, body: JSON.stringify({ action, confirmation }),
      });
      expect((await fetch(endpoint)).status).toBe(403);
      expect((await post("export", "EXPORT", { origin: "https://evil.example" })).status).toBe(403);
      expect((await post("export", "wrong")).status).toBe(400);
      expect((await post("purge", "PERMANENTLY DELETE ARCHIVE")).status).toBe(400);
      expect((await post("purge", "STOPPED WORKFLOWS; PERMANENTLY DELETE ARCHIVE")).status).toBe(409);
      expect((await post("export", "EXPORT")).status).toBe(200);
      const exportPath = join(root, "state-export.json");
      expect(await readFile(exportPath, "utf8")).toContain("synthetic@example.com");
      expect(await readFile(exportPath, "utf8")).not.toContain(key.toString("base64"));
      expect((await post("export", "EXPORT")).status).toBe(200); // Identical export is idempotent.
      await writeFile(queuePath, JSON.stringify({ queue: [{ id: "newer" }] }));
      expect((await post("quarantine", "STOPPED WORKFLOWS")).status).toBe(409);
      expect((await store.read("fixture:1"))?.state).toMatchObject({ stage: "waiting-human" });
      await writeFile(queuePath, JSON.stringify({ queue: [] }));
      await mkdir(join(root, "workflow.lock"));
      expect((await post("quarantine", "STOPPED WORKFLOWS")).status).toBe(409);
      expect((await store.read("fixture:1"))?.state).toMatchObject({ stage: "waiting-human" });
      await rm(join(root, "workflow.lock"), { recursive: true });
      expect((await post("quarantine", "STOPPED WORKFLOWS")).status).toBe(200);
      expect(await store.read("fixture:1")).toBeUndefined();
      expect(await fetch(endpoint, { headers }).then((r) => r.json())).toEqual({
        exportReady: true, archiveReady: true });
      expect((await post("restore", "STOPPED WORKFLOWS")).status).toBe(200);
      expect((await store.read("fixture:1"))?.state).toEqual({
        stage: "waiting-human", email: "synthetic@example.com" });
      expect((await post("quarantine", "STOPPED WORKFLOWS")).status).toBe(200);
      expect((await post("purge", "STOPPED WORKFLOWS; PERMANENTLY DELETE ARCHIVE")).status).toBe(200);
      await expect(lstat(join(root, "removed-state"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await store.read("fixture:1")).toBeUndefined();
      expect(await readFile(exportPath, "utf8")).toContain("synthetic@example.com");
      await expect(lstat(join(root, "workflow.lock"))).rejects.toMatchObject({ code: "ENOENT" });
      const html = await fetch(ui.url).then((r) => r.text());
      expect(html).toContain("Purge permanently removes that archive");
      expect(html).toContain("the export, onboarding templates, and OS secrets remain");
    } finally { await ui.close(); await rm(base, { recursive: true, force: true }); }
  }, 120_000);
});
