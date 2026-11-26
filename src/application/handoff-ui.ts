import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { ApplicationCheckpoint } from "./state-machine.js";

const reply = (response: ServerResponse, status: number, data: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
};
const requestSchema = z.strictObject({
  updatedAt: z.string().datetime(), handoffId: z.string().uuid().optional(),
  authorizeContinuation: z.literal(true),
  answers: z.array(z.strictObject({ field: z.string().trim().min(1).max(300),
    value: z.string().trim().min(1).max(4000) })).max(10),
}).superRefine((value, context) => {
  if (new Set(value.answers.map((answer) => answer.field)).size !== value.answers.length) {
    context.addIssue({ code: "custom", message: "Answer fields must be unique" });
  }
});
export type HandoffResponse = z.infer<typeof requestSchema>;

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 50_000) throw new Error("Handoff response is too large");
  }
  return JSON.parse(text) as unknown;
}

export async function startHandoffUi(options: {
  jobId: string;
  jobLabel?: string;
  loadCheckpoint: () => Promise<ApplicationCheckpoint | undefined>;
  resume: (checkpoint: ApplicationCheckpoint, answers: HandoffResponse["answers"]) => Promise<void>;
  port?: number;
}) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let busy = false;
  let lastError: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.slice(7) || !request.url) {
        return reply(response, 403, { error: "Invalid host" });
      }
      const url = new URL(request.url, origin);
      if (url.pathname === "/" && request.method === "GET" && url.searchParams.get("token") === token) {
        const nonce = randomBytes(16).toString("base64");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        response.end(page(token, nonce));
        return;
      }
      if (request.headers["x-openapply-token"] !== token
        || (request.method !== "GET" && request.headers.origin !== origin)) {
        return reply(response, 403, { error: "Handoff authorization failed" });
      }
      if (url.pathname === "/api/handoff" && request.method === "GET") {
        const checkpoint = await options.loadCheckpoint();
        if (!checkpoint || checkpoint.jobId !== options.jobId) {
          return reply(response, 404, { error: "Application handoff not found" });
        }
        return reply(response, 200, { jobId: options.jobId, jobLabel: options.jobLabel ?? options.jobId,
          stage: checkpoint.stage,
          blocker: checkpoint.stage === "waiting-human" ? checkpoint.blocker : null,
          officialUrl: checkpoint.officialUrl, updatedAt: checkpoint.updatedAt,
          handoffId: checkpoint.handoffId,
          busy, ...(lastError ? { error: lastError } : {}) });
      }
      if (url.pathname !== "/api/resume" || request.method !== "POST") {
        return reply(response, 404, { error: "Unknown handoff route" });
      }
      if (request.headers["content-type"] !== "application/json") {
        return reply(response, 415, { error: "JSON is required" });
      }
      if (busy) return reply(response, 409, { error: "Application is already resuming" });
      const input = requestSchema.parse(await readBody(request));
      const checkpoint = await options.loadCheckpoint();
      if (!checkpoint || checkpoint.jobId !== options.jobId
        || checkpoint.stage !== "waiting-human" || !checkpoint.packagePath) {
        return reply(response, 409, { error: "No resumable handoff exists" });
      }
      if (checkpoint.updatedAt !== input.updatedAt || checkpoint.handoffId !== input.handoffId) {
        return reply(response, 409, { error: "Application changed; reload before continuing" });
      }
      if (busy) return reply(response, 409, { error: "Application is already resuming" });
      busy = true;
      lastError = undefined;
      void options.resume(checkpoint, input.answers).catch(() => {
        lastError = "Resume failed; inspect the local application log and try again.";
      }).finally(() => { busy = false; });
      return reply(response, 202, { accepted: true });
    } catch {
      return reply(response, 400, { error: "Invalid handoff response" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/?token=${token}`, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}

function page(token: string, nonce: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenApply · Application handoff</title><style nonce="${nonce}">
:root{font:16px/1.5 system-ui,sans-serif;color:#17323c;background:#f7f3e9}*{box-sizing:border-box}body{margin:0}
main{max-width:760px;margin:7vh auto;padding:24px}h1{font:normal clamp(36px,6vw,58px)/1.05 Georgia,serif;margin:8px 0 24px}
.eyebrow{letter-spacing:.15em;text-transform:uppercase;color:#aa4d2b;font-size:13px;font-weight:700}
.card{background:#fff;padding:28px;border:1px solid #b8c1bd}p{margin:10px 0 18px}label{display:block;margin:20px 0 6px}
input[type=text],textarea{width:100%;padding:12px;font:inherit;border:1px solid #556d74}textarea{min-height:90px}
button{padding:12px 20px;border:0;background:#17323c;color:white;font:inherit;cursor:pointer;margin-top:18px}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #b95431;outline-offset:2px}
.row{border-top:1px solid #d3d8d2;margin-top:24px;padding-top:8px}.hint{font-size:14px;color:#51676e}
@media(max-width:700px){main{margin:0;padding:16px}.card{padding:20px}}
</style><main><div class="eyebrow">OpenApply / Private handoff</div><h1>An application needs you.</h1>
<div class="card"><h2 id="job"></h2><p id="status" role="status" aria-live="polite">Loading application…</p>
<p id="blocker"></p><p class="hint">Complete any CAPTCHA, MFA, or identity check in the application browser. For a missing answer, enter the exact field label and your answer below.</p>
<div id="answers"><div class="row"><label>Question or field label <input class="field" type="text" maxlength="300" autocomplete="off"></label>
<label>Your answer <textarea class="value" maxlength="4000"></textarea></label></div></div>
<button id="add" type="button">Add another answer</button>
<label><input id="authorize" type="checkbox"> I reviewed this response and authorize this application to continue and submit if ready.</label>
<button id="resume">Continue application</button></div></main>
<script nonce="${nonce}">
const token=${JSON.stringify(token)};let checkpoint;
const status=document.getElementById('status'),blocker=document.getElementById('blocker');
async function refresh(){const response=await fetch('/api/handoff',{headers:{'x-openapply-token':token}});const data=await response.json();if(!response.ok){status.textContent=data.error;return}checkpoint=data;document.getElementById('job').textContent=data.jobLabel;status.textContent=data.busy?'Resuming application…':'Application status: '+data.stage+(data.error?' · '+data.error:'');blocker.textContent=data.blocker||'';if(data.busy)setTimeout(refresh,1500)}
document.getElementById('add').onclick=()=>{const box=document.getElementById('answers');if(box.children.length>=10)return;const row=box.firstElementChild.cloneNode(true);row.querySelector('.field').value='';row.querySelector('.value').value='';box.append(row)};
document.getElementById('resume').onclick=async()=>{if(!checkpoint||checkpoint.stage!=='waiting-human'){status.textContent='No pending handoff';return}if(!document.getElementById('authorize').checked){status.textContent='Review and authorize continuation first';return}const answers=[];for(const row of document.querySelectorAll('#answers .row')){const field=row.querySelector('.field').value.trim(),value=row.querySelector('.value').value.trim();if(Boolean(field)!==Boolean(value)){status.textContent='Provide both a field label and answer';return}if(field)answers.push({field,value})}status.textContent='Starting…';const response=await fetch('/api/resume',{method:'POST',headers:{'content-type':'application/json','x-openapply-token':token},body:JSON.stringify({updatedAt:checkpoint.updatedAt,handoffId:checkpoint.handoffId,authorizeContinuation:true,answers})});const data=await response.json();if(!response.ok){status.textContent=data.error;return}document.getElementById('authorize').checked=false;refresh()};
refresh().catch(()=>{status.textContent='Unable to read handoff'});
</script>`;
}
