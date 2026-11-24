import { describe, expect, it } from "vitest";
import { launchAgentPlist, scheduleConfigSchema } from "../src/scheduler/launchd.js";
import { queueRunnerConfigSchema, setDiscoveryEnvironment } from "../src/application/queue-config.js";

const config = scheduleConfigSchema.parse({ version: 1, repositoryPath: "/private/OpenApply & Projects",
  queueConfigPath: "/private/queue-config.json",
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
    expect(() => scheduleConfigSchema.parse({ ...config, queueConfigPath: "queue-config.json" })).toThrow();
    expect(() => scheduleConfigSchema.parse({ ...config, intervalMinutes: 5 })).toThrow();
  });

  it("uses one queue config for both discovery and applications", () => {
    const queue = queueRunnerConfigSchema.parse({ version: 1, queuePath: "/private/queue.json",
      candidatePath: "/private/candidate.json", preferencesPath: "/private/preferences.json",
      discoveryInputPath: "/private/discovery.json", discoveryStatePath: "/private/state.json",
      browserEndpoint: "http://127.0.0.1:9210/mcp",
      overleafProjectUrl: "https://www.overleaf.com/project/000000000000000000000000",
      outputDirectory: "/private/artifacts" });
    const env: NodeJS.ProcessEnv = { OPENAPPLY_CANDIDATE: "/private/wrong-candidate.json" };
    setDiscoveryEnvironment(queue, env);
    expect(env.OPENAPPLY_CANDIDATE).toBe(queue.candidatePath);
    expect(env.OPENAPPLY_OUTPUT).toBe(queue.queuePath);
  });
});
