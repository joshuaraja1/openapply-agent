import type { ApplicationStateStore, SecretStore } from "../storage/contracts.js";
import type { AuthenticationPolicy } from "./schema.js";
import { selectEmailCode } from "./email-code.js";
import { fetchGmailMessages, fetchMicrosoftMessages } from "./mailbox-clients.js";
import { getMailboxAccessToken } from "./oauth-token.js";

interface UsedMessages { entries: Array<{ id: string; at: string }> }
export interface ActiveEmailCodeRequest {
  accountEmail: string;
  company: string;
  portalHost: string;
  requestedAt: string;
}

/** Claims a selected message before browser entry; interrupted entries require human recovery. */
export class EmailCodeEntry {
  constructor(private readonly policy: AuthenticationPolicy, private readonly secrets: SecretStore,
    private readonly ledger: ApplicationStateStore<UsedMessages>, private readonly fetcher: typeof fetch = fetch) {}

  async resolve(request: ActiveEmailCodeRequest): Promise<string | undefined> {
    const config = this.policy.emailVerification;
    if (!config.enabled || !config.autoEnter || !config.provider || !config.accountId) return undefined;
    const account = this.policy.accounts.find((entry) => entry.id === config.accountId);
    if (!account || account.email.toLowerCase() !== request.accountEmail.toLowerCase()) return undefined;
    const now = new Date();
    const saved = await this.ledger.read("mailbox-message-claims");
    const used = new Set(saved?.state.entries.map((entry) => entry.id) ?? []);
    const token = await getMailboxAccessToken(this.policy, this.secrets, this.fetcher, now.getTime());
    const messages = config.provider === "gmail"
      ? await fetchGmailMessages(token, request.requestedAt, this.fetcher)
      : await fetchMicrosoftMessages(token, request.requestedAt, this.fetcher);
    const selected = selectEmailCode(messages, { ...request, now: now.toISOString(),
      allowedSenderDomains: config.allowedSenderDomains,
      maximumMessageAgeSeconds: config.maximumMessageAgeSeconds, consumedMessageIds: used });
    if (!selected) return undefined;
    const entries = (saved?.state.entries ?? []).filter((entry) =>
      Date.parse(entry.at) > now.getTime() - 86_400_000);
    entries.push({ id: selected.messageId, at: now.toISOString() });
    if (!await this.ledger.compareAndSwap("mailbox-message-claims", saved?.version, { entries })) {
      throw new Error("Email-code claim changed concurrently; human review required");
    }
    return selected.code;
  }
}
