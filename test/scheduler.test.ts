import { describe, expect, it } from "vitest";
import { launchAgentPlist, scheduleConfigSchema } from "../src/scheduler/launchd.js";

const config = scheduleConfigSchema.parse({ version: 1, repositoryPath: "/private/OpenApply & Projects",
  discoveryInputPath: "/private/input.json", candidatePath: "/private/candidate.json",
  preferencesPath: "/private/preferences.json", discoveryStatePath: "/private/state.json",
  queuePath: "/private/queue.json", queueConfigPath: "/private/queue-config.json",
  intervalMinutes: 60 });

describe("macOS background schedule", () => {
  it("escapes paths and runs the compiled sequential workflow", () => {
    const plist = launchAgentPlist(config, "/usr/local/bin/node", "/private/logs");
    expect(plist).toContain("OpenApply &amp; Projects/dist/application/autopilot-cli.js");
    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).toContain("OPENAPPLY_QUEUE_CONFIG");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).not.toContain("OpenApply & Projects");
  });

  it("rejects relative paths and overly frequent runs", () => {
    expect(() => scheduleConfigSchema.parse({ ...config, candidatePath: "candidate.json" })).toThrow();
    expect(() => scheduleConfigSchema.parse({ ...config, intervalMinutes: 5 })).toThrow();
  });
});
