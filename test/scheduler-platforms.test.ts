import { describe, expect, it } from "vitest";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { scheduleConfigSchema } from "../src/scheduler/launchd.js";
import { isManagedSystemdUnits, systemdUnits } from "../src/scheduler/systemd.js";
import { windowsRegistrationScript, windowsRemovalScript, windowsRunner } from "../src/scheduler/windows.js";

const config = scheduleConfigSchema.parse({ version: 1,
  repositoryPath: "/private/OpenApply Project", queueConfigPath: "/private/queue.json",
  intervalMinutes: 60 });
const exec = promisify(execFile);

describe("user-level recurring schedule rendering", () => {
  it("defaults an installed schedule to the current package root", () => {
    const installed = scheduleConfigSchema.parse({ version: 1,
      queueConfigPath: "/private/queue.json", intervalMinutes: 60 });
    expect(isAbsolute(installed.repositoryPath)).toBe(true);
    expect(installed.repositoryPath).not.toBe(config.repositoryPath);
  });
  it("renders a systemd user timer with a compiled autopilot command", () => {
    const { service, timer } = systemdUnits(config, "/usr/bin/node",
      "/private/OpenApply Project/dist/src/application/autopilot-cli.js", "/private/logs");
    expect(service).toContain('ExecStart="/usr/bin/node" "/private/OpenApply Project/dist/src/application/autopilot-cli.js"');
    expect(service).toContain('Environment="OPENAPPLY_QUEUE_CONFIG=/private/queue.json"');
    expect(timer).toContain("OnUnitInactiveSec=60min");
    expect(timer).toContain("WantedBy=timers.target");
    expect(service).not.toContain("npm run");
    expect(isManagedSystemdUnits(service, timer)).toBe(true);
    expect(isManagedSystemdUnits(service.replace("OpenApply managed", "Other managed"), timer)).toBe(false);
  });

  it("escapes systemd expansion and rejects control characters", () => {
    const escaped = systemdUnits({ ...config, queueConfigPath: "/private/100% queue.json" },
      "/usr/bin/node", "/private/run.js", "/private/logs");
    expect(escaped.service).toContain("100%% queue.json");
    expect(() => systemdUnits({ ...config, queueConfigPath: "/private/bad\npath" },
      "/usr/bin/node", "/private/run.js", "/private/logs")).toThrow(/control/);
    expect(() => systemdUnits({ ...config, queueConfigPath: "/private/$HOME/queue.json" },
      "/usr/bin/node", "/private/run.js", "/private/logs")).toThrow(/expansion/);
  });

  it.runIf(process.platform === "linux")("passes systemd's unit verifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openapply-systemd-"));
    try {
      const script = join(directory, "autopilot-cli.js");
      await writeFile(script, "// synthetic executable path");
      const units = systemdUnits({ ...config, repositoryPath: directory },
        process.execPath, script, directory);
      const service = join(directory, "openapply-agent.service");
      const timer = join(directory, "openapply-agent.timer");
      await writeFile(service, units.service);
      await writeFile(timer, units.timer);
      await exec("systemd-analyze", ["verify", service, timer]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("quotes PowerShell paths without treating them as commands", () => {
    const runner = windowsRunner({ ...config, queueConfigPath: "C:\\Users\\O'Brien\\queue.json" },
      "C:\\Program Files\\node.exe", "C:\\OpenApply\\autopilot-cli.js", "C:\\Users\\logs");
    expect(runner).toContain("'C:\\Users\\O''Brien\\queue.json'");
    expect(runner).toContain("& 'C:\\Program Files\\node.exe' 'C:\\OpenApply\\autopilot-cli.js'");
    expect(runner).toContain("exit $LASTEXITCODE");
  });

  it("registers an interactive, limited-rights Windows task without a password", () => {
    const script = windowsRegistrationScript(config, "C:\\Users\\Example\\scheduled-run.ps1");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-MultipleInstances IgnoreNew");
    expect(script).toContain("-RepetitionInterval (New-TimeSpan -Minutes 60)");
    expect(script).not.toMatch(/-Password|-LogonType Password/i);
    expect(() => windowsRegistrationScript(config, "C:\\bad\"path")).toThrow();
    const removal = windowsRemovalScript("C:\\Users\\Example\\scheduled-run.ps1");
    expect(removal).toContain("Refusing to remove a task not managed by OpenApply");
    expect(removal).toContain("$task.Actions[0].Arguments -ne");
    expect(removal).toContain("$task.Principal.LogonType -ne 'Interactive'");
  });
});
