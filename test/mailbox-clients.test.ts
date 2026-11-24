import { describe, expect, it, vi } from "vitest";
import { fetchGmailMessages, fetchMicrosoftMessages } from "../src/auth/mailbox-clients.js";

const response = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

describe("scoped mailbox API clients", () => {
  it("uses Gmail's fixed API host and decodes a plain-text message", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, options: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, options });
      if (url.includes("/messages?")) return response({ messages: [{ id: "message-1" }] });
      return response({ id: "message-1", internalDate: "1795536030000",
        payload: { headers: [
          { name: "From", value: "Example Co <verify@mail.example.com>" },
          { name: "To", value: "Candidate <candidate@example.com>" },
          { name: "Subject", value: "Example Co verification" },
        ], mimeType: "text/plain", body: {
          data: Buffer.from("Your verification code is 123456.").toString("base64url"),
        } },
      });
    }) as unknown as typeof fetch;
    const messages = await fetchGmailMessages("private-token", "2026-11-24T16:00:00Z", fetcher);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.bodyText).toContain("123456");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => new URL(call.url).hostname === "gmail.googleapis.com"
      && call.options.redirect === "error"
      && (call.options.headers as Record<string, string>).Authorization === "Bearer private-token")).toBe(true);
    expect(calls[0]?.url).toContain("after%3A");
  });

  it("requests text bodies from Microsoft Graph and maps recipient addresses", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, options: RequestInit = {}) => {
      expect(new URL(String(input)).hostname).toBe("graph.microsoft.com");
      expect((options.headers as Record<string, string>).Prefer).toBe('outlook.body-content-type="text"');
      return response({ value: [{ id: "graph-1", receivedDateTime: "2026-11-24T16:00:30Z",
        subject: "Example Co verification",
        from: { emailAddress: { address: "verify@mail.example.com" } },
        toRecipients: [{ emailAddress: { address: "candidate@example.com" } }],
        body: { contentType: "text", content: "Your verification code is 123456." },
      }] });
    }) as unknown as typeof fetch;
    const messages = await fetchMicrosoftMessages("private-token", "2026-11-24T16:00:00Z", fetcher);
    expect(messages[0]).toMatchObject({ id: "graph-1", to: ["candidate@example.com"],
      bodyText: "Your verification code is 123456." });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
