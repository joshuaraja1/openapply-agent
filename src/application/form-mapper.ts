import type { CandidateProfile } from "../candidate/schema.js";
import type { AgentBrowser, BrowserControl, BrowserSnapshot } from "../browser/actions.js";
import type { Provider } from "../types.js";
import { providerIdentityValue } from "./provider-adapters.js";

export interface FormAction {
  name: string;
  tag: string;
  type: string | null;
  action: "fill" | "upload";
  value: string;
}

export interface FormPlan {
  actions: FormAction[];
  blockers: string[];
}

function key(control: BrowserControl): string {
  return `${control.tag}:${control.type ?? ""}:${control.name.trim().toLowerCase()}`;
}

export function isEmailCodeControl(control: BrowserControl): boolean {
  return control.tag === "input" && [null, "text", "tel", "number"].includes(control.type)
    && /^(email (?:verification|one.time|security) code|code (?:sent to|from) (?:your )?email)$/i
      .test(control.name.trim());
}

function valueFor(control: BrowserControl, candidate: CandidateProfile, resumePath: string,
  provider?: Provider): FormAction | undefined {
  const label = control.name.trim().toLowerCase().replace(/[*:]+$/, "").trim();
  const type = control.type?.toLowerCase() ?? null;
  if (control.tag === "input" && type === "file" && /\b(resume|résumé|cv)\b/.test(label)) {
    return { name: control.name, tag: control.tag, type: control.type, action: "upload", value: resumePath };
  }
  if (!(["input", "textarea"].includes(control.tag)) || ["hidden", "password", "file", "checkbox", "radio", "submit"].includes(type ?? "")) return undefined;
  const parts = candidate.identity.fullName.trim().split(/\s+/);
  const fields: Array<[RegExp, string | undefined]> = [
    [/^(first name|given name)$/i, parts[0]],
    [/^(last name|family name|surname)$/i, parts.length > 1 ? parts.slice(1).join(" ") : undefined],
    [/^(full name|your name|name)$/i, candidate.identity.fullName],
    [/^(email|email address|e-mail)$/i, candidate.identity.email],
    [/^(phone|phone number|mobile|mobile phone)$/i, candidate.identity.phone],
    [/^(location|city and state|current location)$/i, candidate.identity.location],
    [/^(portfolio|portfolio url|personal website|website)$/i, candidate.identity.portfolio],
    [/^(github|github url|github profile)$/i, candidate.identity.github],
    [/^(linkedin|linkedin url|linkedin profile)$/i, candidate.identity.linkedin],
  ];
  const match = fields.find(([pattern]) => pattern.test(label));
  const value = match?.[1] ?? providerIdentityValue(provider, label, candidate);
  if (!value) return undefined;
  return { name: control.name, tag: control.tag, type: control.type, action: "fill", value };
}

/** Only maps exact common fields. Unknown required questions need a human or a provider adapter. */
export function planApplicationForm(snapshot: BrowserSnapshot, candidate: CandidateProfile, resumePath: string,
  options: { approvedHumanAnswers?: ReadonlyMap<string, string>; allowMissingResume?: boolean;
    provider?: Provider } = {}): FormPlan {
  const actions: FormAction[] = [];
  const blockers: string[] = [];
  if (/\b(captcha|verify you are human|security code|authenticator code)\b/i.test(snapshot.visibleText ?? "")) {
    blockers.push("Human verification is present on the application page");
  }
  const counts = new Map<string, number>();
  for (const control of snapshot.controls) counts.set(key(control), (counts.get(key(control)) ?? 0) + 1);
  for (const control of snapshot.controls) {
    if (control.tag === "button" || control.type === "submit" || control.tag === "a") continue;
    if (isEmailCodeControl(control) && /^\d{6}$/.test(control.value ?? "")) continue;
    if (/captcha|verification code|one.time code|security question/i.test(control.name)) {
      blockers.push(`Human verification needed: ${control.name}`);
      continue;
    }
    const approved = options.approvedHumanAnswers?.get(control.name);
    const safeApprovedAnswer = approved && ["input", "textarea"].includes(control.tag)
      && [null, "text", "tel", "number", "email", "url"].includes(control.type)
      && !/\b(attest|certify|criminal|disability|ethnicity|race|gender|veteran|clearance|export|sanction|consent|agree)\b/i
        .test(control.name);
    const action = valueFor(control, candidate, resumePath, options.provider)
      ?? (safeApprovedAnswer ? { name: control.name, tag: control.tag, type: control.type,
        action: "fill" as const, value: approved } : undefined);
    if (action && counts.get(key(control)) === 1) actions.push(action);
    else if (control.required && !(control.value?.trim()
      && options.approvedHumanAnswers?.get(control.name) === control.value
      && !["checkbox", "radio", "select", "file"].includes(control.type ?? control.tag)
      && !/\b(attest|certify|criminal|disability|ethnicity|race|gender|veteran|clearance|export|sanction|consent|agree)\b/i
        .test(control.name))) {
      blockers.push(`Required field needs an answer: ${control.name || control.type || control.tag}`);
    }
  }
  if (!options.allowMissingResume && !actions.some((action) => action.action === "upload")) {
    blockers.push("Resume upload control was not found; verify this application step before submission");
  }
  return { actions, blockers };
}

export async function fillApplicationForm(
  browser: Pick<AgentBrowser, "act"> & { fillBatch?: (actions: FormAction[]) => Promise<BrowserSnapshot> },
  snapshot: BrowserSnapshot,
  candidate: CandidateProfile,
  resumePath: string,
  options: { approvedHumanAnswers?: ReadonlyMap<string, string>; allowMissingResume?: boolean;
    provider?: Provider } = {},
): Promise<{ snapshot: BrowserSnapshot; blockers: string[]; uploaded: boolean }> {
  const plan = planApplicationForm(snapshot, candidate, resumePath, options);
  if (plan.blockers.length) return { snapshot, blockers: plan.blockers, uploaded: false };
  const initialCounts = new Map<string, number>();
  for (const control of snapshot.controls) initialCounts.set(key(control), (initialCounts.get(key(control)) ?? 0) + 1);
  const postFillBlockers = (current: BrowserSnapshot, uploaded: boolean): string[] => {
    const blockers = planApplicationForm(current, candidate, resumePath, options).blockers.filter((blocker) =>
      !uploaded || blocker !== "Resume upload control was not found; verify this application step before submission");
    const seen = new Map<string, number>();
    for (const control of current.controls) {
      const id = key(control);
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (control.required && seen.get(id)! > (initialCounts.get(id) ?? 0)) {
        blockers.push(`New required field appeared after filling: ${control.name || control.type || control.tag}`);
      }
    }
    return blockers;
  };
  if (browser.fillBatch) {
    const filled = await browser.fillBatch(plan.actions);
    if (filled.url !== snapshot.url) throw new Error("Application page changed during form filling");
    const uploaded = plan.actions.some((action) => action.action === "upload");
    return { snapshot: filled, blockers: postFillBlockers(filled, uploaded), uploaded };
  }
  let current = snapshot;
  let uploaded = false;
  for (const action of plan.actions) {
    if (current.url !== snapshot.url) throw new Error("Application page changed during form filling");
    const matching = current.controls.filter((control) => key(control) === `${action.tag}:${action.type ?? ""}:${action.name.trim().toLowerCase()}`);
    if (matching.length !== 1) throw new Error(`Form field changed during filling: ${action.name}`);
    current = await browser.act(matching[0]!.ref, action.action, action.value);
    uploaded ||= action.action === "upload";
    const blockers = postFillBlockers(current, uploaded);
    if (blockers.length) return { snapshot: current, blockers, uploaded };
  }
  if (current.url !== snapshot.url) throw new Error("Application page changed during form filling");
  return { snapshot: current, blockers: postFillBlockers(current, uploaded), uploaded };
}
