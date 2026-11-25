import { readPrivateFile } from "../storage/private-path.js";
import { queueRunnerConfigSchema, setDiscoveryEnvironment } from "./queue-config.js";

const configPath = process.env.OPENAPPLY_QUEUE_CONFIG;
if (!configPath) throw new Error("Set OPENAPPLY_QUEUE_CONFIG to a private queue-runner configuration");
const config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(configPath)));
setDiscoveryEnvironment(config, process.env);
// Dynamic imports preserve the required discovery -> queue execution order.
await import("../cli.js");
await import("./queue-cli.js");
