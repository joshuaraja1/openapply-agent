import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

export async function readSecretInput(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 4096) throw new Error("Secret input exceeds 4096 bytes");
    chunks.push(bytes);
  }
  const value = Buffer.concat(chunks).toString("utf8");
  if (!value || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("Secret input must be nonempty and contain no line breaks");
  }
  return value;
}
