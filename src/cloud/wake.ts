import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { z } from "zod";
import type { SecretStore } from "../storage/contracts.js";
import { writePrivateAtomicJson } from "../storage/discovery-output.js";
import { readPrivateFile } from "../storage/private-path.js";

const absolutePath = z.string().refine(isAbsolute, "Use an absolute path");
const endpoint = z.url().refine((raw) => {
  const url = new URL(raw);
  return url.protocol === "https:" && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/v1/tick";
}, "Use an HTTPS /v1/tick endpoint without credentials or query parameters");
export const cloudWakeConfigSchema = z.object({
  version: z.literal(1), endpoint, queueConfigPath: absolutePath,
  cursorPath: absolutePath.default(join(userInfo().homedir, ".openapply-agent", "cloud-wake.json")),
  tokenReference: z.string().regex(/^(keychain|secret-service|credential-manager):\/\/cloud-wake\/[A-Za-z0-9._/-]+$/),
  pollSeconds: z.number().int().min(30).max(300).default(60),
}).strict();
export type CloudWakeConfig = z.infer<typeof cloudWakeConfigSchema>;

/** Avoid repeated macOS Keychain prompts during a long-running watcher process. */
export function cacheWakeSecret(store: Pick<SecretStore, "get">): Pick<SecretStore, "get"> {
  const values = new Map<string, string>();
  return { get: async (reference) => {
    const cached = values.get(reference);
    if (cached) return cached;
    const value = await store.get(reference);
    if (value) values.set(reference, value);
    return value;
  } };
}
const tickSchema = z.object({ generation: z.number().int().nonnegative().safe(),
  issuedAt: z.iso.datetime() }).strict();
const cursorSchema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative().safe() }).strict();

async function readCursor(path: string): Promise<number> {
  try { return cursorSchema.parse(JSON.parse(await readPrivateFile(path))).generation; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function runAutopilotChild(queueConfigPath: string): Promise<void> {
  // The child holds the existing workflow lease and runs discovery before queue execution.
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "application", "autopilot-cli.js");
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, OPENAPPLY_QUEUE_CONFIG: queueConfigPath }, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? done() : reject(new Error(
      `OpenApply workflow exited unsuccessfully (${signal ?? code ?? "unknown"})`)));
  });
}

/** A failed run leaves the cursor unchanged, so the next poll retries through existing checkpoints. */
export async function runCloudWakeOnce(config: CloudWakeConfig, secrets: Pick<SecretStore, "get">,
  dependencies: { fetch?: typeof fetch; run?: (queueConfigPath: string) => Promise<void> } = {},
): Promise<"idle" | "ran"> {
  const parsed = cloudWakeConfigSchema.parse(config);
  await readPrivateFile(parsed.queueConfigPath); // refuse a missing or shared workflow config
  const token = await secrets.get(parsed.tokenReference);
  if (!token || token.length < 32) throw new Error("Cloud wake token is unavailable or too short");
  const response = await (dependencies.fetch ?? fetch)(parsed.endpoint, {
    method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cloud wake endpoint returned ${response.status}`);
  const body = await response.text();
  if (body.length > 1024) throw new Error("Cloud wake response is oversized");
  const tick = tickSchema.parse(JSON.parse(body));
  const last = await readCursor(parsed.cursorPath);
  if (tick.generation < last) throw new Error("Cloud wake generation moved backwards");
  if (tick.generation === last) return "idle";
  await (dependencies.run ?? runAutopilotChild)(parsed.queueConfigPath);
  await writePrivateAtomicJson(parsed.cursorPath, { version: 1, generation: tick.generation });
  return "ran";
}
