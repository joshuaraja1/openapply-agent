import { readPrivateFile } from "../storage/private-path.js";
import { queueRunnerConfigSchema, setDiscoveryEnvironment } from "./queue-config.js";
import { holdWorkflowLease } from "../storage/workflow-lease.js";
import { runScheduledBrowserDiscovery } from "./autopilot-browser-discovery.js";

await holdWorkflowLease();

const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to a private queue-runner configuration");
const config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
setDiscoveryEnvironment(config, process.env);
// An ambient path must never import stale or unconfigured board leads.
delete process.env.OPENAPPLY_BROWSER_LEADS;
const browserLeadsPath = await runScheduledBrowserDiscovery(config);
if (browserLeadsPath) process.env.OPENAPPLY_BROWSER_LEADS = browserLeadsPath;
// Dynamic imports preserve the required discovery -> queue execution order.
await import("../cli.js");
await import("./queue-cli.js");
