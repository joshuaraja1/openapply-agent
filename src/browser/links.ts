import type { BrowserLead, BrowserPlatform } from "./schema.js";

const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const rawUrl = /https?:\/\/[^\s<>)\]]+/g;

function cleanUrl(raw: string, platform: BrowserPlatform, ownedGeneric = false): string | null {
  try {
    const url = new URL(raw.replace(/[.,;:]+$/, ""));
    if (url.username || url.password) return null;
    url.hash = "";
    if (url.hostname.endsWith("linkedin.com") && url.pathname.includes("/jobs/view/")) url.search = "";
    if (url.hostname === "jobright.ai" && url.pathname.includes("/jobs/info/")) url.search = "";
    if (platform === "handshake") url.search = "";
    if (platform === "generic" && ownedGeneric) {
      for (const key of [...url.searchParams.keys()]) {
        if (!/^(?:id|jobid|job_id|gh_jid|req_id|requisitionid)$/i.test(key)) url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function accepts(platform: BrowserPlatform, value: string, sourceSearchUrl: string,
  ownedGeneric = false): boolean {
  const url = new URL(value);
  if (platform === "linkedin") {
    return url.hostname.endsWith("linkedin.com") && url.pathname.includes("/jobs/view/");
  }
  if (platform === "jobright") {
    return url.hostname === "jobright.ai" && url.pathname.includes("/jobs/info/");
  }
  if (platform === "handshake") {
    return url.hostname.endsWith("joinhandshake.com") && /\/jobs\//.test(url.pathname);
  }
  if (!ownedGeneric) return url.protocol === "http:" || url.protocol === "https:";
  const source = new URL(sourceSearchUrl);
  return url.origin === source.origin
    && /\/(?:jobs?|careers?|positions?|openings?|postings?|requisitions?|roles?|apply)(?:\/|$)/i
      .test(url.pathname)
    && !/[?&](?:token|code|session|auth|key|password)=/i.test(url.search);
}

export function extractBrowserLeads(
  text: string,
  context: { platform: BrowserPlatform; sourceSearchUrl: string; observedAt: string;
    ownedGeneric?: boolean },
): BrowserLead[] {
  const named = new Map<string, string>();
  for (const match of text.matchAll(markdownLink)) {
    const url = cleanUrl(match[2] ?? "", context.platform, context.ownedGeneric);
    if (url && accepts(context.platform, url, context.sourceSearchUrl, context.ownedGeneric))
      named.set(url, (match[1] ?? "Job listing").trim());
  }
  for (const match of text.matchAll(rawUrl)) {
    const url = cleanUrl(match[0], context.platform, context.ownedGeneric);
    if (url && accepts(context.platform, url, context.sourceSearchUrl, context.ownedGeneric) && !named.has(url))
      named.set(url, "Job listing");
  }
  return [...named].map(([url, title]) => ({
    platform: context.platform,
    title,
    url,
    sourceSearchUrl: context.sourceSearchUrl,
    observedAt: context.observedAt,
  }));
}
