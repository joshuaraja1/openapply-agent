import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open, rename, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { assertPrivateFile, readPrivateFile } from "../storage/private-path.js";
import { createPrivateOutput } from "../storage/private-output.js";
import { secureWindowsPrivatePath } from "../storage/windows-acl.js";
import { compileCandidateMarkdown, compileSearchMarkdown } from "../candidate/markdown.js";
import { scoreJob } from "../matching/score.js";
import type { DiscoveredJob } from "../types.js";
import { initializeUserWorkspace, userTemplateFiles } from "./init.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const names = new Set<string>(userTemplateFiles);
const limit = 250_000;

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let value = "";
  for await (const part of request) {
    value += part.toString();
    if (value.length > limit) throw new Error("Template exceeds the size limit");
  }
  return JSON.parse(value) as unknown;
}

async function setupProfile(destination: string) {
  const [profile, work, search] = await Promise.all([
    readPrivateFile(join(destination, "01-candidate-profile.md")),
    readPrivateFile(join(destination, "02-work-history.md")),
    readPrivateFile(join(destination, "03-search-preferences.md")),
  ]);
  return { candidate: compileCandidateMarkdown(profile, work), preferences: compileSearchMarkdown(search) };
}

async function profileReadiness(destination: string): Promise<{ valid: boolean; compiled: boolean; current: boolean }> {
  let candidate: unknown;
  let preferences: unknown;
  try {
    ({ candidate, preferences } = await setupProfile(destination));
  } catch {
    return { valid: false, compiled: false, current: false };
  }
  try {
    const [savedCandidate, savedPreferences] = await Promise.all([
      readPrivateFile(join(destination, "candidate-profile.json")),
      readPrivateFile(join(destination, "search-preferences.json")),
    ]);
    return { valid: true, compiled: true,
      current: digest(savedCandidate) === digest(`${JSON.stringify(candidate, null, 2)}\n`)
        && digest(savedPreferences) === digest(`${JSON.stringify(preferences, null, 2)}\n`) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: true, compiled: false, current: false };
    }
    throw error;
  }
}

export async function startSetupUi(options: { destination?: string; repositoryRoot: string; port?: number }) {
  const destination = options.destination ?? join(userInfo().homedir, ".openapply-agent", "onboarding");
  await initializeUserWorkspace(destination, options.repositoryRoot);
  const token = randomBytes(32).toString("hex");
  const busy = new Set<string>();
  let origin = "";
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (host !== origin.slice(7) || !request.url) return send(response, 403, { error: "Invalid host" });
      const url = new URL(request.url, origin);
      if (url.pathname === "/" && request.method === "GET" && url.searchParams.get("token") === token) {
        const nonce = randomBytes(16).toString("base64");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        response.end(page(token, nonce));
        return;
      }
      if (request.headers["x-openapply-token"] !== token
        || (request.method !== "GET" && request.headers.origin !== origin)) {
        return send(response, 403, { error: "Setup authorization failed" });
      }
      if (url.pathname === "/api/templates" && request.method === "GET") {
        const files = await Promise.all(userTemplateFiles.map(async (name) => {
          const content = await readPrivateFile(join(destination, name));
          return { name, content, sha256: digest(content), complete: !content.includes("{{") };
        }));
        return send(response, 200, { files });
      }
      if (url.pathname === "/api/readiness" && request.method === "GET") {
        return send(response, 200, await profileReadiness(destination));
      }
      if (url.pathname === "/api/compile" && request.method === "POST") {
        const { candidate, preferences } = await setupProfile(destination);
        await createPrivateOutput(join(destination, "candidate-profile.json"),
          `${JSON.stringify(candidate, null, 2)}\n`);
        await createPrivateOutput(join(destination, "search-preferences.json"),
          `${JSON.stringify(preferences, null, 2)}\n`);
        return send(response, 200, { compiled: true,
          approvedClaims: [...candidate.education, ...candidate.experience.flatMap((role) => role.claims),
            ...candidate.projects.flatMap((project) => project.claims)]
            .filter((claim) => claim.status === "verified" || claim.status === "user-confirmed").length });
      }
      if (url.pathname === "/api/preview" && request.method === "POST") {
        if (request.headers["content-type"] !== "application/json") {
          return send(response, 415, { error: "JSON is required" });
        }
        const input = await body(request) as Record<string, unknown> | null;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return send(response, 400, { error: "Invalid preview posting" });
        }
        const { title, description, location, compensation } = input;
        if (typeof title !== "string" || !title.trim() || title.length > 200
          || typeof description !== "string" || !description.trim() || description.length > 100_000
          || (location !== undefined && (typeof location !== "string" || location.length > 200))
          || (compensation !== undefined && (typeof compensation !== "string" || compensation.length > 200))) {
          return send(response, 400, { error: "Provide a job title and description within the size limits" });
        }
        const { candidate, preferences } = await setupProfile(destination);
        const now = new Date().toISOString();
        const job: DiscoveredJob = {
          id: "preview:local", provider: "jsonld", company: "Preview posting", title,
          descriptionText: description, location: location ?? null, workplaceType: null,
          compensation: compensation ?? null, department: null, employmentType: null,
          applicationUrl: "https://preview.invalid/apply", sourceUrl: "https://preview.invalid/job",
          sourcePublishedAt: null, sourceUpdatedAt: null, firstSeenAt: now, discoveredAt: now,
          isNew: false, isFresh: false, freshnessBasis: "first-seen", matchedKeywords: [],
        };
        return send(response, 200, { previewOnly: true, match: scoreJob(job, candidate, preferences) });
      }
      const name = decodeURIComponent(url.pathname.slice("/api/template/".length));
      if (!url.pathname.startsWith("/api/template/") || !names.has(name) || request.method !== "PUT") {
        return send(response, 404, { error: "Unknown setup route" });
      }
      if (request.headers["content-type"] !== "application/json") {
        return send(response, 415, { error: "JSON is required" });
      }
      const input = await body(request);
      if (!input || typeof input !== "object") return send(response, 400, { error: "Invalid template update" });
      const { content, expectedSha256 } = input as { content?: unknown; expectedSha256?: unknown };
      if (typeof content !== "string" || content.length > limit
        || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
        return send(response, 400, { error: "Invalid template update" });
      }
      if (busy.has(name)) return send(response, 409, { error: "Template is being saved" });
      busy.add(name);
      try {
        const target = join(destination, name);
        await assertPrivateFile(target);
        if (digest(await readPrivateFile(target)) !== expectedSha256) {
          return send(response, 409, { error: "Template changed; reload before saving" });
        }
        const temporary = join(destination, `.${name}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            if (process.platform === "win32") await secureWindowsPrivatePath(temporary);
            await handle.writeFile(content);
            await handle.sync();
          } finally { await handle.close(); }
          await rename(temporary, target);
          if (process.platform !== "win32") {
            const directory = await open(dirname(target), "r");
            try { await directory.sync(); } finally { await directory.close(); }
          }
        } finally { await unlink(temporary).catch(() => {}); }
        return send(response, 200, { name, sha256: digest(content), complete: !content.includes("{{") });
      } finally { busy.delete(name); }
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Setup request failed" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Setup server failed to bind");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/?token=${token}`, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}

function page(token: string, nonce: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenApply · First run</title><style nonce="${nonce}">
:root{color-scheme:light;--ink:#182a32;--paper:#f7f2e8;--line:#c4c8c2;--accent:#d35e37;--muted:#5b6c71}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 "Avenir Next",Avenir,sans-serif}
header{padding:42px clamp(22px,6vw,90px) 28px;border-bottom:2px solid var(--ink);display:flex;justify-content:space-between;gap:20px;align-items:end}
.brand{font:700 13px/1.2 "Avenir Next",sans-serif;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
h1{font:normal clamp(38px,5vw,70px)/.95 Georgia,serif;letter-spacing:-.055em;margin:12px 0 0;max-width:850px}
.eyebrow{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
main{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:clamp(24px,5vw,78px);padding:40px clamp(22px,6vw,90px)}
nav{border-top:1px solid var(--ink)}nav button{width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);padding:17px 10px;font:inherit;color:var(--ink);cursor:pointer;display:flex;justify-content:space-between;gap:12px}
nav button[aria-current=page]{color:var(--accent);font-weight:700}nav button:hover{background:#eee6d7}.status{font-size:12px;color:var(--muted)}
section{min-width:0}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:12px}
h2{font:normal clamp(27px,3vw,42px)/1 Georgia,serif;margin:0}.note{color:var(--muted);max-width:650px;margin:12px 0 20px}
textarea{width:100%;min-height:min(62vh,750px);padding:22px;background:#fffefa;border:1px solid var(--ink);border-radius:2px;color:var(--ink);font:14px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
textarea:focus,button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.preview{margin-top:34px;padding-top:24px;border-top:1px solid var(--line)}.preview label{display:block;margin:14px 0 5px}.preview input{width:100%;padding:10px;background:#fffefa;border:1px solid var(--ink);font:inherit}.preview textarea{min-height:150px}
.preview pre{white-space:pre-wrap;background:#fffefa;padding:14px;border:1px solid var(--line)}
.actions{display:flex;gap:18px;align-items:center;margin:18px 0;flex-wrap:wrap}.save{border:0;background:var(--ink);color:white;padding:12px 24px;font:700 14px "Avenir Next",sans-serif;cursor:pointer}.save:hover{background:var(--accent)}.compile{border:1px solid var(--ink);background:transparent;color:var(--ink);padding:11px 20px;font:700 14px "Avenir Next",sans-serif;cursor:pointer}.compile:hover{background:#eee6d7}
#message{color:var(--muted);font-size:14px}footer{padding:20px clamp(22px,6vw,90px);border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media(max-width:760px){header{display:block}main{display:block;padding-top:22px}nav{display:grid;grid-template-columns:1fr 1fr;margin-bottom:28px}nav button{font-size:13px}}
</style><header><div><div class="brand">OpenApply / Local setup</div><h1>Your experience, in your words.</h1></div><div class="eyebrow">Private on this device</div></header>
<main><nav id="files" aria-label="Setup sections"></nav><section><div class="section-head"><h2 id="title">Loading setup</h2><div class="eyebrow" id="progress"></div></div>
<p class="note">Complete each template with verified facts. The first three files supply résumé and matching data. Your answers stay in your private OpenApply folder.</p>
<label for="editor" class="eyebrow">Template contents</label><textarea id="editor" spellcheck="false"></textarea>
<div class="actions"><button class="save" id="save">Save this section</button><button class="compile" id="compile">Compile profile</button><button class="compile" id="readiness-check">Check readiness</button><span id="message" role="status" aria-live="polite"></span></div>
<p id="readiness" role="status" aria-live="polite">Profile readiness has not been checked.</p>
<div class="preview"><h2>Try a job match</h2><p class="note">Paste a posting to check your saved evidence and search preferences. This local preview does not verify the employer posting, create a résumé, or apply.</p>
<label for="preview-title">Job title</label><input id="preview-title" maxlength="200">
<label for="preview-description">Job description</label><textarea id="preview-description" maxlength="100000"></textarea>
<div class="actions"><button class="compile" id="preview-run">Preview match</button></div><pre id="preview-result" role="status" aria-live="polite">No preview yet</pre></div></section></main>
<footer>Local setup · Close this tab and stop the setup process when finished.</footer>
<script nonce="${nonce}">
const token=${JSON.stringify(token)};let files=[],selected=0;const editor=document.getElementById('editor'),message=document.getElementById('message');
const labels=['Candidate profile','Work history','Search preferences','Source policy','Résumé tailoring','Application answers','Run configuration','Authentication'];
function render(){const current=files[selected];document.getElementById('files').replaceChildren(...files.map((file,index)=>{const button=document.createElement('button');button.textContent=(index+1).toString().padStart(2,'0')+'  '+labels[index];button.setAttribute('aria-current',index===selected?'page':'false');button.onclick=()=>{if(editor.value!==files[selected].content&&!confirm('Discard unsaved changes?'))return;selected=index;render()};return button}));
document.getElementById('title').textContent=labels[selected];document.getElementById('progress').textContent=files.filter(file=>file.complete).length+' / '+files.length+' sections without placeholders';editor.value=current.content;message.textContent=current.complete?'No placeholders detected':'Replace the {{PLACEHOLDER}} values before compiling your profile';}
async function load(){const response=await fetch('/api/templates',{headers:{'x-openapply-token':token}});if(!response.ok)throw Error('Could not load private templates');files=(await response.json()).files;render()}
async function checkReadiness(){const output=document.getElementById('readiness');if(editor.value!==files[selected].content){output.textContent='Save this section before checking readiness.';return}output.textContent='Checking private profile…';try{const response=await fetch('/api/readiness',{headers:{'x-openapply-token':token}});const data=await response.json();if(!response.ok)throw Error(data.error);output.textContent=!data.valid?'Complete and validate templates 01–03 before compiling.':!data.compiled?'Templates 01–03 are valid. Compile the profile to create private output files.':!data.current?'Compiled profile is stale. Move the old private output files aside, then compile again.':'Profile is compiled and current. Continue with source, browser, and account setup.'}catch(error){output.textContent=error.message}}
document.getElementById('readiness-check').onclick=checkReadiness;
document.getElementById('save').onclick=async()=>{const current=files[selected];message.textContent='Saving…';try{const response=await fetch('/api/template/'+encodeURIComponent(current.name),{method:'PUT',headers:{'content-type':'application/json','x-openapply-token':token},body:JSON.stringify({content:editor.value,expectedSha256:current.sha256})});const data=await response.json();if(!response.ok)throw Error(data.error);files[selected]={...current,...data,content:editor.value};render();message.textContent='Saved privately'}catch(error){message.textContent=error.message}};
document.getElementById('compile').onclick=async()=>{if(editor.value!==files[selected].content){message.textContent='Save this section before compiling';return}message.textContent='Validating profile…';try{const response=await fetch('/api/compile',{method:'POST',headers:{'x-openapply-token':token}});const data=await response.json();if(!response.ok)throw Error(data.error);message.textContent='Profile compiled privately · '+data.approvedClaims+' approved claims';await checkReadiness()}catch(error){message.textContent=error.message}};
document.getElementById('preview-run').onclick=async()=>{const result=document.getElementById('preview-result');if(editor.value!==files[selected].content){result.textContent='Save this section before previewing';return}result.textContent='Checking…';try{const response=await fetch('/api/preview',{method:'POST',headers:{'content-type':'application/json','x-openapply-token':token},body:JSON.stringify({title:document.getElementById('preview-title').value,description:document.getElementById('preview-description').value})});const data=await response.json();if(!response.ok)throw Error(data.error);const match=data.match;result.textContent=(match.eligible?'Potential match':'Needs review')+' · score '+match.score+'\\n'+match.reasons.join('\\n')+'\\nMatched skills: '+(match.matchedSkills.join(', ')||'none')+(match.reviewFlags.length?'\\nReview: '+match.reviewFlags.join('; '):'')}catch(error){result.textContent=error.message}};
load().catch(error=>{message.textContent=error.message});
</script></html>`;
}
