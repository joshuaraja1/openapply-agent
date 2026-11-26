import { spawn } from "node:child_process";

/** Keep approved answers in a one-shot pipe, never in argv or the environment. */
export async function runResumeChild(args: string[], env: NodeJS.ProcessEnv,
  answerPayload?: string): Promise<void> {
  const child = spawn(process.execPath, args,
    { env, stdio: answerPayload ? ["pipe", "inherit", "inherit"] : "inherit" });
  if (answerPayload) {
    child.stdin!.on("error", () => { /* The child failure is reported by close. */ });
    child.stdin!.end(answerPayload);
  }
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error("Application resume failed");
}
