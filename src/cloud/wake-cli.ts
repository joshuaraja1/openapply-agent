import { setTimeout as delay } from "node:timers/promises";
import { readPrivateFile } from "../storage/private-path.js";
import { createNativeSecretStore } from "../storage/native-secret-store.js";
import { cacheWakeSecret, cloudWakeConfigSchema, runCloudWakeOnce } from "./wake.js";

const path = process.env.OPENAPPLY_CLOUD_WAKE_CONFIG;
if (!path) throw new Error("Set OPENAPPLY_CLOUD_WAKE_CONFIG to a private cloud-wake configuration");
const config = cloudWakeConfigSchema.parse(JSON.parse(await readPrivateFile(path)));
const secrets = cacheWakeSecret(createNativeSecretStore());
const once = process.argv.includes("--once");
do {
  try {
    const result = await runCloudWakeOnce(config, secrets);
    if (result === "ran") console.log("Cloud wake completed one local OpenApply run");
  } catch (error) {
    if (once) throw error;
    console.error(`Cloud wake check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!once) await delay(config.pollSeconds * 1000);
} while (!once);
