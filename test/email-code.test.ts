import { describe, expect, it } from "vitest";
import { selectEmailCode, type EmailCodeRequest, type MailboxMessage } from "../src/auth/email-code.js";

const request: EmailCodeRequest = {
  accountEmail: "candidate@example.com", company: "Example Co", portalHost: "jobs.example.com",
  requestedAt: "2026-11-24T16:00:00Z", now: "2026-11-24T16:01:00Z",
  allowedSenderDomains: ["mail.example.com"], maximumMessageAgeSeconds: 300,
};
const message: MailboxMessage = {
  id: "message-1", receivedAt: "2026-11-24T16:00:30Z",
  from: "Example Co <verify@mail.example.com>", to: ["candidate@example.com"],
  subject: "Example Co verification", bodyText: "Your verification code is 123456.",
};

describe("scoped email-code selection", () => {
  it("selects one fresh code and refuses a consumed message", () => {
    expect(selectEmailCode([message], request)).toEqual({ messageId: "message-1", code: "123456" });
    expect(selectEmailCode([message], { ...request, consumedMessageIds: new Set(["message-1"]) }))
      .toBeUndefined();
    expect(selectEmailCode([{ ...message,
      from: '"Example, Inc." <verify@mail.example.com>' }], request)?.code).toBe("123456");
  });

  it("ignores spoofed, stale, wrong-account, and unrelated messages", () => {
    const changes: Partial<MailboxMessage>[] = [
      { from: "Example Co <verify@evil.example>" },
      { from: "verify@mail.example.com.evil.example" },
      { from: "Attacker <evil@evil.example>, Verify <verify@mail.example.com>" },
      { receivedAt: "2026-11-24T15:59:00Z" },
      { to: ["other@example.com"] },
      { subject: "Other company", bodyText: "Your verification code is 123456." },
    ];
    for (const change of changes) {
      expect(selectEmailCode([{ ...message, ...change }], request)).toBeUndefined();
    }
  });

  it("pauses on multiple plausible emails or codes", () => {
    expect(() => selectEmailCode([message, { ...message, id: "message-2" }], request))
      .toThrow("Multiple plausible");
    expect(() => selectEmailCode([{ ...message,
      bodyText: "Your verification code is 123456. Your security code is 654321." }], request))
      .toThrow("Multiple verification codes");
  });

  it("does not match a short company name inside an unrelated word", () => {
    const shortCompany = { ...request, company: "AI" };
    const unrelated = { ...message, subject: "Your email verification",
      bodyText: "Your verification code is 123456." };
    expect(selectEmailCode([unrelated], shortCompany)).toBeUndefined();
    expect(selectEmailCode([{ ...unrelated, subject: "AI verification" }], shortCompany))
      .toEqual({ messageId: "message-1", code: "123456" });
    expect(selectEmailCode([{ ...unrelated, subject: "𐐀AI verification" }], shortCompany))
      .toBeUndefined();
  });

  it("rejects portal-host lookalikes in email content", () => {
    const hostOnly = { ...request, company: "Unmentioned Company" };
    for (const host of ["evil.jobs.example.com", "jobs.example.com.evil"] ) {
      expect(selectEmailCode([{ ...message, subject: "Verification",
        bodyText: `Your verification code is 123456 for ${host}.` }], hostOnly)).toBeUndefined();
    }
    expect(selectEmailCode([{ ...message, subject: "Verification",
      bodyText: "Your verification code is 123456 for jobs.example.com." }], hostOnly)?.code)
      .toBe("123456");
  });

  it("rejects a verification window that has already expired", () => {
    expect(() => selectEmailCode([message], { ...request,
      now: "2026-11-24T16:10:00Z" })).toThrow("request is invalid");
  });
});
