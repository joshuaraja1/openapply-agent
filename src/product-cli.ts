#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const commands: Record<string, () => Promise<unknown>> = {
  setup: () => import("./setup/ui-cli.js"),
  "setup:init": () => import("./setup/init-cli.js"),
  "profile:compile": () => import("./candidate/markdown-cli.js"),
  "browser:doctor": () => import("./browser/doctor-cli.js"),
  "browser:benchmark": () => import("./browser/benchmark-cli.js"),
  "browser:open": () => import("./browser/open-cli.js"),
  "browser:discover": () => import("./browser/cli.js"),
  autopilot: () => import("./application/autopilot-cli.js"),
  "queue:run": () => import("./application/queue-cli.js"),
  "application:run": () => import("./application/cli.js"),
  "schedule:install": async () => (await import("./scheduler/cli.js")).runScheduleAction("install"),
  "schedule:remove": async () => (await import("./scheduler/cli.js")).runScheduleAction("remove"),
  "application:status": () => import("./application/status-cli.js"),
  "application:review": () => import("./application/uncertain-review-cli.js"),
  "application:verify-owned": () => import("./application/owned-confirm-cli.js"),
  handoff: () => import("./application/handoff-ui-cli.js"),
  "resume:render": () => import("./resume/cli.js"),
  "resume:review": () => import("./resume/review-cli.js"),
  "secret:put": () => import("./auth/secret-put-cli.js"),
  "oauth:connect": () => import("./auth/oauth-connect-cli.js"),
  "state:cutover": () => import("./storage/sqlite-cutover-cli.js"),
  "state:control": () => import("./storage/data-controls-cli.js"),
};

const command = process.argv[2];
if (!command || command === "--help" || command === "help") {
  console.log(`OpenApply local CLI\n\nUsage: openapply <command>\n\nCommands:\n  ${[
    ...Object.keys(commands), "browser:install",
  ].join("\n  ")}\n\nSet private configuration paths with OPENAPPLY_* environment variables.\nSee the bundled README for setup and consent requirements.`);
} else if (command === "browser:install") {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = status;
} else {
  const run = commands[command];
  if (!run) {
    console.error(`Unknown OpenApply command: ${command}`);
    process.exitCode = 2;
  } else await run();
}
