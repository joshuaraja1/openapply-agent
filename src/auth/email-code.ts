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
  requestedAt: string;
  now: string;
  allowedSenderDomains: string[];
  maximumMessageAgeSeconds: number;
  consumedMessageIds?: ReadonlySet<string>;
}

function senderAddress(value: string): string | undefined {
  if (value.includes(",") || (value.match(/</g)?.length ?? 0) > 1
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

function containsContext(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** Selects only one fresh, job-bound email code. Ambiguity always pauses automation. */
export function selectEmailCode(messages: MailboxMessage[], request: EmailCodeRequest):
  { messageId: string; code: string } | undefined {
  const requestedAt = Date.parse(request.requestedAt);
  const now = Date.parse(request.now);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(now) || requestedAt > now
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
    if (!containsContext(content, company) && !containsContext(content, portalHost)) continue;
    const codes = verificationCodes(content);
    if (codes.length > 1) throw new Error("Multiple verification codes were found in one email");
    if (codes[0]) candidates.push({ messageId: message.id, code: codes[0] });
  }
  if (candidates.length > 1) throw new Error("Multiple plausible verification emails were found");
  return candidates[0];
}
