import type { ApplicationStateStore, SecretStore } from "../storage/contracts.js";
import type { AuthenticationPolicy } from "./schema.js";
import { selectEmailCode } from "./email-code.js";
import { fetchGmailMessages, fetchMicrosoftMessages } from "./mailbox-clients.js";
import { getMailboxAccessToken } from "./oauth-token.js";
import { setTimeout as delay } from "node:timers/promises";

interface UsedMessages {
  entries: Array<{ id: string; at: string }>;
  challenges: Array<{ jobId: string; accountEmail: string; company: string; at: string }>;
}
export interface ActiveEmailCodeRequest {
  jobId: string;
  accountEmail: string;
  company: string;
  portalHost: string;
  requestedAt: string;
}

/** Claims a selected message before browser entry; interrupted entries require human recovery. */
export class EmailCodeEntry {
  constructor(private readonly policy: AuthenticationPolicy, private readonly secrets: SecretStore,
    private readonly ledger: ApplicationStateStore<UsedMessages>, private readonly fetcher: typeof fetch = fetch,
    private readonly maxWaitMs = 30_000, private readonly pollMs = 2_000) {}

  async resolve(request: ActiveEmailCodeRequest): Promise<string | undefined> {
    const config = this.policy.emailVerification;
    if (!config.enabled || !config.autoEnter || !config.provider || !config.accountId) return undefined;
    const account = this.policy.accounts.find((entry) => entry.id === config.accountId);
    if (!account || account.email.toLowerCase() !== request.accountEmail.toLowerCase()) return undefined;
    if (!request.jobId || !request.company.trim()) return undefined;
    const started = Date.now();
    const saved = await this.ledger.read("mailbox-message-claims");
    const challenges = (saved?.state.challenges ?? []).filter((entry) =>
      Date.parse(entry.at) > started - 600_000);
    if (challenges.some((entry) => entry.jobId !== request.jobId
      && entry.accountEmail === request.accountEmail.toLowerCase()
      && entry.company === request.company.toLowerCase())) return undefined;
    if (!challenges.some((entry) => entry.jobId === request.jobId)) {
      challenges.push({ jobId: request.jobId, accountEmail: request.accountEmail.toLowerCase(),
        company: request.company.toLowerCase(), at: new Date(started).toISOString() });
      if (!await this.ledger.compareAndSwap("mailbox-message-claims", saved?.version, {
        entries: saved?.state.entries ?? [], challenges,
      })) throw new Error("Email-code challenge changed concurrently; human review required");
    }
    const token = await getMailboxAccessToken(this.policy, this.secrets, this.fetcher, started);
    while (true) {
      const now = new Date();
      const messages = config.provider === "gmail"
        ? await fetchGmailMessages(token, request.requestedAt, this.fetcher)
        : await fetchMicrosoftMessages(token, request.requestedAt, this.fetcher);
      const latest = await this.ledger.read("mailbox-message-claims");
      const used = new Set(latest?.state.entries.map((entry) => entry.id) ?? []);
      const selected = selectEmailCode(messages, { ...request, now: now.toISOString(),
        allowedSenderDomains: config.allowedSenderDomains,
        maximumMessageAgeSeconds: config.maximumMessageAgeSeconds, consumedMessageIds: used });
      if (selected) {
        const entries = (latest?.state.entries ?? []).filter((entry) =>
          Date.parse(entry.at) > now.getTime() - 86_400_000);
        entries.push({ id: selected.messageId, at: now.toISOString() });
        if (!await this.ledger.compareAndSwap("mailbox-message-claims", latest?.version,
          { entries, challenges: latest?.state.challenges ?? [] })) {
          throw new Error("Email-code claim changed concurrently; human review required");
        }
        return selected.code;
      }
      const remaining = this.maxWaitMs - (Date.now() - started);
      if (remaining <= 0) return undefined;
      await delay(Math.min(this.pollMs, remaining));
    }
  }
}
