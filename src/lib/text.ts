import { Parser } from "htmlparser2";

export function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

export function htmlToText(value: string): string {
  const parts: string[] = [];
  let hiddenDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (name === "script" || name === "style") {
        if (!hiddenDepth) parts.push(" ");
        hiddenDepth += 1;
      } else if (!hiddenDepth) parts.push(" ");
    },
    ontext(text) {
      if (!hiddenDepth) parts.push(text);
    },
    onclosetag(name) {
      if (name === "script" || name === "style") {
        hiddenDepth = Math.max(0, hiddenDepth - 1);
        if (!hiddenDepth) parts.push(" ");
      } else if (!hiddenDepth) parts.push(" ");
    },
  }, { decodeEntities: true });
  parser.end(value);
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function isoOrNull(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
