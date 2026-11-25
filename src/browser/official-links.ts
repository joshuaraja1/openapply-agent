import { officialSourceForLead } from "./verify-official.js";

const urlPattern = /https:\/\/[^\s<>)\]]+/g;

/** Extract only direct, recognized ATS posting links from a board detail page. */
export function extractOfficialPostingLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(urlPattern)) {
    const raw = (match[0] ?? "").replace(/[.,;:]+$/, "");
    if (!officialSourceForLead(raw)) continue;
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    found.add(url.href);
  }
  return [...found];
}
