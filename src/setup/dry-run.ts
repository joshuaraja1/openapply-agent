import { readPrivateFile } from "../storage/private-path.js";
import { join } from "node:path";
import { discoveryInputSchema, sourceUrl } from "../config.js";
import { queueRunnerConfigSchema } from "../application/queue-config.js";
import { userTemplateFiles } from "./init.js";
import { inspectRuntimeReadiness, runSetupBrowserDoctor } from "./runtime-readiness.js";
import type { BrowserDoctorResult } from "../browser/doctor.js";

type Status = "ready" | "action-required";
type CheckId = "templates" | "compiled-profile" | "queue-and-sources"
  | "browser-installation" | "overleaf-session" | "handoff";
export interface SetupDryRunCheck { id: CheckId; status: Status; action: string }
export interface SetupDryRunReport {
  previewOnly: true;
  readyForPrivatePreview: boolean;
  readyForLiveApplications: false;
  checks: SetupDryRunCheck[];
}

const check = (id: CheckId, ready: boolean, action: string): SetupDryRunCheck => ({
  id, status: ready ? "ready" : "action-required", action,
});

/** Minimum editor signal, not a judgment that the candidate's answers are true. */
export function templateDraftReady(contents: string): boolean {
  return contents.replace(/\s/g, "").length >= 12 && !contents.includes("{{");
}

/** A read-only checklist. It never returns candidate content, URLs, or secret references. */
export async function runSetupDryRun(input: {
  destination: string;
  queueConfigPath: string;
  profile: { valid: boolean; compiled: boolean; current: boolean };
  browserDoctor?: (profileDirectory: string) => Promise<BrowserDoctorResult>;
  probeOwnedOverleaf?: (projectUrl: string) => Promise<boolean>;
}): Promise<SetupDryRunReport> {
  let templatesComplete = true;
  for (const name of userTemplateFiles) {
    try {
      const contents = await readPrivateFile(join(input.destination, name));
      if (!templateDraftReady(contents)) templatesComplete = false;
    }
    catch { templatesComplete = false; }
  }
  const runtime = await inspectRuntimeReadiness(input.queueConfigPath, input.destination);
  let config: ReturnType<typeof queueRunnerConfigSchema.parse> | undefined;
  let sourceReady = false;
  if (runtime.queueConfig === "ready") {
    try {
      config = queueRunnerConfigSchema.parse(JSON.parse(await readPrivateFile(input.queueConfigPath)));
      const discovery = discoveryInputSchema.parse(JSON.parse(await readPrivateFile(config.discoveryInputPath)));
      const enabled = discovery.sources.filter((source) => source.enabled);
      sourceReady = enabled.length > 0 && enabled.every((source) => {
        try {
          const url = new URL(sourceUrl(source));
          return url.protocol === "https:" && !url.username && !url.password;
        } catch { return false; }
      });
    } catch { sourceReady = false; }
  }
  const profileReady = input.profile.valid && input.profile.compiled && input.profile.current
    && runtime.profilePaths === "ready" && runtime.preferences === "ready";
  const queueReady = runtime.queueConfig === "ready" && sourceReady;
  let browserReady = false;
  if (queueReady && runtime.browser === "owned-configured") {
    try { browserReady = await runSetupBrowserDoctor(input.queueConfigPath, input.browserDoctor) === "ready"; }
    catch { browserReady = false; }
  }
  let sessionReady = false;
  if (browserReady && runtime.overleaf === "ready" && config && input.probeOwnedOverleaf) {
    try { sessionReady = await input.probeOwnedOverleaf(config.overleafProjectUrl); }
    catch { sessionReady = false; }
  }
  const handoffReady = runtime.notification === "ready" || runtime.notification === "optional";
  const checks = [
    check("templates", templatesComplete,
      templatesComplete ? "All eight private templates contain text and have no placeholders."
        : "Complete and save nonempty answers in all eight private templates, including policies and application answers."),
    check("compiled-profile", profileReady,
      profileReady ? "Compiled candidate evidence and search preferences are current."
        : "Validate templates 01–03 and compile a current private profile."),
    check("queue-and-sources", queueReady,
      queueReady ? "Private queue and at least one official source are configured."
        : "Save private runtime settings and enable at least one valid official source."),
    check("browser-installation", browserReady,
      browserReady ? "Owned Chromium starts in an isolated temporary profile."
        : "Install owned Chromium and rerun this check; BrowserOS sessions need a separate manual check."),
    check("overleaf-session", sessionReady,
      sessionReady ? "The dedicated browser can open the configured Overleaf editor."
        : "Overleaf editor unverified under the restricted check. Sign in to the dedicated browser or inspect the project manually before preparing an application."),
    check("handoff", handoffReady,
      handoffReady ? "A local review handoff is available; email delivery is only confirmed by a separate send test."
        : "Configure a handoff channel or require final approval before running applications."),
  ];
  return { previewOnly: true, readyForPrivatePreview: checks.every((item) => item.status === "ready"),
    readyForLiveApplications: false, checks };
}
