import { z } from "zod";
import type { MailboxMessage } from "./email-code.js";

type Fetcher = typeof fetch;
const gmailList = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).max(10).optional() });
const gmailMessage = z.object({ id: z.string().min(1), internalDate: z.string(),
  snippet: z.string().optional(), payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
    mimeType: z.string().optional(), body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(z.any()).optional(),
  }).optional() });
const graphList = z.object({ value: z.array(z.object({
  id: z.string().min(1), receivedDateTime: z.string(), subject: z.string().nullable(),
  from: z.object({ emailAddress: z.object({ address: z.string() }) }).optional(),
  toRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })).default([]),
  body: z.object({ contentType: z.string(), content: z.string() }).optional(),
})).max(10) });
const gmailProfile = z.object({ emailAddress: z.email() });
const graphProfile = z.object({ mail: z.email().nullable().optional(),
  userPrincipalName: z.email().optional() });

async function getJson(url: URL, token: string, fetcher: Fetcher, headers: Record<string, string> = {}): Promise<unknown> {
  if (!token || /[\r\n]/.test(token)) throw new Error("Mailbox access token is invalid");
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, ...headers },
    redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Mailbox API request failed with HTTP ${response.status}`);
  const maximumBytes = 2_000_000;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Mailbox API response is too large");
  if (!response.body) throw new Error("Mailbox API response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("Mailbox API response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function gmailHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? "";
}

function gmailPlainText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const part = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, 50_000);
  }
  return (part.parts ?? []).map(gmailPlainText).join("\n").slice(0, 50_000);
}

/** Gmail readonly scope; list is time-filtered, then each message is fetched by fixed API host. */
export async function fetchGmailMessages(token: string, requestedAt: string,
  fetcher: Fetcher = fetch): Promise<MailboxMessage[]> {
  const since = Math.floor(Date.parse(requestedAt) / 1000);
  if (!Number.isFinite(since)) throw new Error("Invalid email-code request time");
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", "10");
  listUrl.searchParams.set("q", `after:${since}`);
  const listed = gmailList.parse(await getJson(listUrl, token, fetcher));
  const messages: MailboxMessage[] = [];
  for (const item of listed.messages ?? []) {
    const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}`);
    detailUrl.searchParams.set("format", "full");
    const detail = gmailMessage.parse(await getJson(detailUrl, token, fetcher));
    const headers = detail.payload?.headers ?? [];
    messages.push({ id: detail.id, receivedAt: new Date(Number(detail.internalDate)).toISOString(),
      from: gmailHeader(headers, "from"),
      to: gmailHeader(headers, "to").split(",").map((value) => value.trim()),
      subject: gmailHeader(headers, "subject"),
      bodyText: gmailPlainText(detail.payload) || detail.snippet || "" });
  }
  return messages;
}

/** Microsoft Graph delegated Mail.Read scope; returns only recent message fields. */
export async function fetchMicrosoftMessages(token: string, requestedAt: string,
  fetcher: Fetcher = fetch): Promise<MailboxMessage[]> {
  if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("Invalid email-code request time");
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", "10");
  url.searchParams.set("$select", "id,receivedDateTime,subject,from,toRecipients,body");
  url.searchParams.set("$filter", `receivedDateTime ge ${new Date(requestedAt).toISOString()}`);
  url.searchParams.set("$orderby", "receivedDateTime desc");
  const parsed = graphList.parse(await getJson(url, token, fetcher,
    { Prefer: 'outlook.body-content-type="text"' }));
  return parsed.value.map((item) => ({ id: item.id, receivedAt: item.receivedDateTime,
    from: item.from?.emailAddress.address ?? "",
    to: item.toRecipients.map((recipient) => recipient.emailAddress.address),
    subject: item.subject ?? "",
    bodyText: item.body?.contentType.toLowerCase() === "text"
      ? item.body.content.slice(0, 50_000) : "",
  }));
}

export async function fetchMailboxAccountEmail(provider: "gmail" | "microsoft", token: string,
  fetcher: Fetcher = fetch): Promise<string> {
  if (provider === "gmail") {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    return gmailProfile.parse(await getJson(url, token, fetcher)).emailAddress.toLowerCase();
  }
  const url = new URL("https://graph.microsoft.com/v1.0/me");
  url.searchParams.set("$select", "mail,userPrincipalName");
  const profile = graphProfile.parse(await getJson(url, token, fetcher));
  const email = profile.mail ?? profile.userPrincipalName;
  if (!email) throw new Error("Microsoft mailbox identity is unavailable");
  return email.toLowerCase();
}
