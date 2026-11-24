export interface MailboxMessage {
  id: string;
  receivedAt: string;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
}

export interface EmailCodeRequest {
  accountEmail: string;
  company: string;
  portalHost: string;
  jobTitle?: string;
  requestedAt: string;
  now: string;
  allowedSenderDomains: string[];
  maximumMessageAgeSeconds: number;
  consumedMessageIds?: ReadonlySet<string>;
}

function senderAddress(value: string): string | undefined {
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) return undefined;
  }
  if (quoted || (value.match(/</g)?.length ?? 0) > 1
    || (value.match(/>/g)?.length ?? 0) > 1) return undefined;
  const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  const address = (bracketed?.[1] ?? value.trim()).toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : undefined;
}

function allowedSender(address: string, domains: string[]): boolean {
  const domain = address.split("@")[1]!;
  return domains.some((entry) => {
    const approved = entry.toLowerCase();
    return approved.startsWith("*.")
      ? domain.endsWith(approved.slice(1)) && domain !== approved.slice(2)
      : domain === approved;
  });
}

function verificationCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(/\b(?:verification|security|one[ -]?time|confirmation|access)\s+code\b[^\d]{0,50}(\d{6})\b/gi)) {
    codes.add(match[1]!);
  }
  for (const match of text.matchAll(/\b(\d{6})\b[^\n.]{0,40}\b(?:verification|security|one[ -]?time|confirmation|access)\s+code\b/gi)) {
    codes.add(match[1]!);
  }
  return [...codes];
}

function containsContext(text: string, phrase: string, kind: "company" | "host"): boolean {
  const adjacent = kind === "host" ? /[\p{L}\p{N}.-]/u : /[\p{L}\p{N}]/u;
  let index = text.indexOf(phrase);
  while (index >= 0) {
    const priorUnit = text.charCodeAt(index - 1);
    const priorIndex = priorUnit >= 0xdc00 && priorUnit <= 0xdfff ? index - 2 : index - 1;
    const before = index > 0 ? text.slice(Math.max(0, priorIndex), index) : undefined;
    const nextIndex = index + phrase.length;
    const nextPoint = text.codePointAt(nextIndex);
    const after = nextPoint === undefined ? undefined : String.fromCodePoint(nextPoint);
    const afterNext = after ? text.codePointAt(nextIndex + after.length) : undefined;
    const hostSuffix = kind === "host" && after === "."
      ? afterNext !== undefined && /[\p{L}\p{N}-]/u.test(String.fromCodePoint(afterNext))
      : Boolean(after && adjacent.test(after));
    if ((!before || !adjacent.test(before)) && !hostSuffix) return true;
    index = text.indexOf(phrase, index + 1);
  }
  return false;
}

/** Selects only one fresh, job-bound email code. Ambiguity always pauses automation. */
export function selectEmailCode(messages: MailboxMessage[], request: EmailCodeRequest):
  { messageId: string; code: string } | undefined {
  const requestedAt = Date.parse(request.requestedAt);
  const now = Date.parse(request.now);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(now) || requestedAt > now
    || now - requestedAt > request.maximumMessageAgeSeconds * 1000
    || !Number.isFinite(request.maximumMessageAgeSeconds)
    || request.maximumMessageAgeSeconds < 30 || request.maximumMessageAgeSeconds > 900
    || !request.allowedSenderDomains.length) {
    throw new Error("Email-code request is invalid");
  }
  const expectedAccount = request.accountEmail.toLowerCase();
  const company = request.company.trim().toLowerCase();
  const portalHost = request.portalHost.toLowerCase();
  if (!company || !portalHost) throw new Error("Email-code request lacks portal context");
  const candidates: Array<{ messageId: string; code: string }> = [];
  for (const message of messages) {
    if (request.consumedMessageIds?.has(message.id)) continue;
    const receivedAt = Date.parse(message.receivedAt);
    if (!Number.isFinite(receivedAt) || receivedAt < requestedAt || receivedAt > now + 30_000
      || now - receivedAt > request.maximumMessageAgeSeconds * 1000) continue;
    const sender = senderAddress(message.from);
    if (!sender || !allowedSender(sender, request.allowedSenderDomains)
      || !message.to.some((recipient) => senderAddress(recipient) === expectedAccount)) continue;
    const content = `${message.subject}\n${message.bodyText}`.toLowerCase().replace(/\s+/g, " ");
    if (request.jobTitle && !containsContext(content, request.jobTitle.trim().toLowerCase(), "company")) continue;
    if (!containsContext(content, company, "company")
      && !containsContext(content, portalHost, "host")) continue;
    const codes = verificationCodes(content);
    if (codes.length > 1) throw new Error("Multiple verification codes were found in one email");
    if (codes[0]) candidates.push({ messageId: message.id, code: codes[0] });
  }
  if (candidates.length > 1) throw new Error("Multiple plausible verification emails were found");
  return candidates[0];
}
