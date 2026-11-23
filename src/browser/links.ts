import type { BrowserLead, BrowserPlatform } from "./schema.js";

const markdownLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const rawUrl = /https?:\/\/[^\s<>)\]]+/g;

function cleanUrl(raw: string): string | null {
  try {
    const url = new URL(raw.replace(/[.,;:]+$/, ""));
    url.hash = "";
    if (url.hostname.endsWith("linkedin.com") && url.pathname.includes("/jobs/view/")) url.search = "";
    if (url.hostname === "jobright.ai" && url.pathname.includes("/jobs/info/")) url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

function accepts(platform: BrowserPlatform, value: string): boolean {
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
  return url.protocol === "http:" || url.protocol === "https:";
}

export function extractBrowserLeads(
  text: string,
  context: { platform: BrowserPlatform; sourceSearchUrl: string; observedAt: string },
): BrowserLead[] {
  const named = new Map<string, string>();
  for (const match of text.matchAll(markdownLink)) {
    const url = cleanUrl(match[2] ?? "");
    if (url && accepts(context.platform, url)) named.set(url, (match[1] ?? "Job listing").trim());
  }
  for (const match of text.matchAll(rawUrl)) {
    const url = cleanUrl(match[0]);
    if (url && accepts(context.platform, url) && !named.has(url)) named.set(url, "Job listing");
  }
  return [...named].map(([url, title]) => ({
    platform: context.platform,
    title,
    url,
    sourceSearchUrl: context.sourceSearchUrl,
    observedAt: context.observedAt,
  }));
}
