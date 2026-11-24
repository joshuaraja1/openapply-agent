import type { CandidateProfile } from "../candidate/schema.js";
import type { AgentBrowser, BrowserControl, BrowserSnapshot } from "../browser/actions.js";

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

function valueFor(control: BrowserControl, candidate: CandidateProfile, resumePath: string): FormAction | undefined {
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
  if (!match?.[1]) return undefined;
  return { name: control.name, tag: control.tag, type: control.type, action: "fill", value: match[1] };
}

/** Only maps exact common fields. Unknown required questions need a human or a provider adapter. */
export function planApplicationForm(snapshot: BrowserSnapshot, candidate: CandidateProfile, resumePath: string): FormPlan {
  const actions: FormAction[] = [];
  const blockers: string[] = [];
  if (/\b(captcha|verify you are human|security code|authenticator code)\b/i.test(snapshot.visibleText ?? "")) {
    blockers.push("Human verification is present on the application page");
  }
  const counts = new Map<string, number>();
  for (const control of snapshot.controls) counts.set(key(control), (counts.get(key(control)) ?? 0) + 1);
  for (const control of snapshot.controls) {
    if (control.tag === "button" || control.type === "submit" || control.tag === "a") continue;
    if (/captcha|verification code|one.time code|security question/i.test(control.name)) {
      blockers.push(`Human verification needed: ${control.name}`);
      continue;
    }
    const action = valueFor(control, candidate, resumePath);
    if (action && counts.get(key(control)) === 1) actions.push(action);
    else if (control.required) blockers.push(`Required field needs an answer: ${control.name || control.type || control.tag}`);
  }
  if (!actions.some((action) => action.action === "upload")) {
    blockers.push("Resume upload control was not found; verify this application step before submission");
  }
  return { actions, blockers };
}

export async function fillApplicationForm(
  browser: Pick<AgentBrowser, "act"> & { fillBatch?: (actions: FormAction[]) => Promise<BrowserSnapshot> },
  snapshot: BrowserSnapshot,
  candidate: CandidateProfile,
  resumePath: string,
): Promise<{ snapshot: BrowserSnapshot; blockers: string[] }> {
  const plan = planApplicationForm(snapshot, candidate, resumePath);
  if (plan.blockers.length) return { snapshot, blockers: plan.blockers };
  if (browser.fillBatch) {
    const filled = await browser.fillBatch(plan.actions);
    if (filled.url !== snapshot.url) throw new Error("Application page changed during form filling");
    return { snapshot: filled, blockers: [] };
  }
  let current = snapshot;
  for (const action of plan.actions) {
    if (current.url !== snapshot.url) throw new Error("Application page changed during form filling");
    const matching = current.controls.filter((control) => key(control) === `${action.tag}:${action.type ?? ""}:${action.name.trim().toLowerCase()}`);
    if (matching.length !== 1) throw new Error(`Form field changed during filling: ${action.name}`);
    current = await browser.act(matching[0]!.ref, action.action, action.value);
  }
  if (current.url !== snapshot.url) throw new Error("Application page changed during form filling");
  return { snapshot: current, blockers: [] };
}
