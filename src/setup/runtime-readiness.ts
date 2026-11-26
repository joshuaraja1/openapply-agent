import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadAuthenticationPolicy } from "../auth/schema.js";
import { checkOwnedBrowser } from "../browser/doctor.js";
import { searchPreferencesSchema } from "../candidate/schema.js";
import { loadHandoffNotificationConfig } from "../application/notification.js";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { assertLocalBrowserEndpoint, assertOverleafProjectUrl } from "../resume/overleaf.js";
import { readPrivateFile } from "../storage/private-path.js";

type State = "missing" | "invalid" | "ready";
export interface RuntimeReadiness {
  queueConfig: State;
  preferences: State;
  profilePaths: State;
  dailyLimit: number | null;
  browser: "missing" | "invalid" | "owned-configured" | "browseros-configured";
  overleaf: State;
  notification: "optional" | State;
  mailbox: "optional" | "invalid" | "client-configured";
}

type QueueConfig = z.infer<typeof queueRunnerConfigSchema>;

async function readConfig(path: string): Promise<QueueConfig> {
  return queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(path)));
}

/** Report configuration presence and validation without returning private values. */
export async function inspectRuntimeReadiness(queueConfigPath: string | undefined,
  setupDirectory: string): Promise<RuntimeReadiness> {
  const result: RuntimeReadiness = {
    queueConfig: "missing", preferences: "missing", profilePaths: "missing", dailyLimit: null,
    browser: "missing", overleaf: "missing", notification: "optional", mailbox: "optional",
  };
  if (!queueConfigPath) return result;
  let config: QueueConfig;
  try { config = await readConfig(queueConfigPath); }
  catch (error) {
    result.queueConfig = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    return result;
  }
  result.queueConfig = "ready";
  result.profilePaths = resolve(config.candidatePath) === resolve(join(setupDirectory, "candidate-profile.json"))
    && resolve(config.preferencesPath) === resolve(join(setupDirectory, "search-preferences.json"))
    ? "ready" : "invalid";
  try {
    const parsed = searchPreferencesSchema.parse(JSON.parse(await readPrivateFile(config.preferencesPath)));
    result.preferences = "ready";
    result.dailyLimit = Math.min(parsed.applicationPolicy.dailyTarget, parsed.applicationPolicy.dailyHardCap);
    result.notification = parsed.applicationPolicy.requireFinalApproval ? "optional" : "missing";
  } catch (error) {
    result.preferences = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
  }
  try {
    if (config.browserRuntime === "browseros") assertLocalBrowserEndpoint(config.browserEndpoint!);
    result.browser = config.browserRuntime === "owned" ? "owned-configured" : "browseros-configured";
  } catch { result.browser = "invalid"; }
  try { assertOverleafProjectUrl(config.overleafProjectUrl); result.overleaf = "ready"; }
  catch { result.overleaf = "invalid"; }
  if (config.notificationConfigPath) {
    try {
      const notification = await loadHandoffNotificationConfig(config.notificationConfigPath);
      result.notification = notification.email ? "ready" : "missing";
    } catch (error) {
      result.notification = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    }
  }
  if (config.authenticationPolicyPath) {
    try {
      const policy = await loadAuthenticationPolicy(config.authenticationPolicyPath);
      result.mailbox = policy.emailVerification.enabled ? "client-configured" : "optional";
    } catch { result.mailbox = "invalid"; }
  }
  return result;
}

/** The explicit doctor action checks the installed owned browser without reading sessions. */
export async function runSetupBrowserDoctor(queueConfigPath: string | undefined,
  doctor: typeof checkOwnedBrowser = checkOwnedBrowser,
  profileDirectory = join(userInfo().homedir, ".openapply-agent", "browser-profile")):
  Promise<"ready" | "external-browser"> {
  if (!queueConfigPath) throw new Error("Configure a private queue file before checking the browser");
  const config = await readConfig(queueConfigPath);
  if (config.browserRuntime === "browseros") {
    assertLocalBrowserEndpoint(config.browserEndpoint!);
    return "external-browser";
  }
  await doctor(profileDirectory);
  return "ready";
}
