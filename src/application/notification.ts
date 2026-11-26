import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { SecretStore } from "../storage/contracts.js";
import { readPrivateFile } from "../storage/private-path.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";

const exec = promisify(execFile);
const secretRef = z.string().regex(
  /^(keychain|credential-manager|secret-service):\/\/[A-Za-z0-9._/@:-]+$/,
).refine((value) => !value.includes("://application-state/"));

export const handoffNotificationSchema = z.strictObject({
  version: z.literal(1),
  email: z.strictObject({
    provider: z.literal("resend"),
    from: z.email(),
    to: z.email(),
    apiKeySecretRef: secretRef,
  }).optional(),
});
export type HandoffNotificationConfig = z.infer<typeof handoffNotificationSchema>;

export async function loadHandoffNotificationConfig(path: string): Promise<HandoffNotificationConfig> {
  if (!isAbsolute(path)) throw new Error("Notification config requires an absolute private path");
  return handoffNotificationSchema.parse(JSON.parse(await readPrivateFile(path)));
}

/** Generic text only: job titles, answers, URLs, and candidate details stay on the device. */
export async function sendHandoffEmail(config: HandoffNotificationConfig, checkpoint: ApplicationCheckpoint,
  secrets: SecretStore, fetcher: typeof fetch = fetch): Promise<void> {
  if (!config.email || checkpoint.stage !== "waiting-human") return;
  const key = await secrets.get(config.email.apiKeySecretRef);
  if (!key) throw new Error("Notification sending key is unavailable in the OS secret store");
  const idempotency = createHash("sha256")
    .update(`${checkpoint.jobId}\0${checkpoint.handoffId ?? checkpoint.updatedAt}\0${config.email.to}`)
    .digest("hex");
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "Idempotency-Key": `openapply-handoff-${idempotency}` },
    body: JSON.stringify({ from: config.email.from, to: [config.email.to],
      subject: "OpenApply needs your attention",
      text: "An application is paused. Open OpenApply on your device to review and continue it." }),
  });
  if (!response.ok) throw new Error(`Handoff email failed with HTTP ${response.status}`);
}

/** A desktop alert is best effort. No private data is included. */
export async function notifyHumanHandoff(): Promise<void> {
  if (process.platform !== "darwin") return;
  await exec("osascript", ["-e", 'display notification "An application needs your attention in OpenApply." with title "OpenApply"']);
}

/** Replay a saved handoff after a crash; sent markers live in encrypted application state. */
export async function notifyPendingHandoff(workflow: ApplicationWorkflow,
  checkpoint: ApplicationCheckpoint, secrets: SecretStore,
  config?: HandoffNotificationConfig,
  options: { desktopEnabled?: boolean; desktop?: () => Promise<void>;
    email?: typeof sendHandoffEmail } = {}): Promise<void> {
  if (checkpoint.stage !== "waiting-human") return;
  const handoffId = checkpoint.handoffId ?? checkpoint.updatedAt;
  const desktopEnabled = options.desktopEnabled ?? process.platform === "darwin";
  if (desktopEnabled && checkpoint.desktopNotifiedFor !== handoffId) {
    try {
      await (options.desktop ?? notifyHumanHandoff)();
      await workflow.markNotification(checkpoint.jobId, "desktop", handoffId);
    } catch { console.warn("Desktop handoff notification was unavailable"); }
  }
  if (config?.email && checkpoint.emailNotifiedFor !== handoffId) {
    try {
      await (options.email ?? sendHandoffEmail)(config, checkpoint, secrets);
      await workflow.markNotification(checkpoint.jobId, "email", handoffId);
    } catch { console.warn("Email handoff notification was unavailable"); }
  }
}
