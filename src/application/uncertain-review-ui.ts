import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UncertainReviewItem } from "./uncertain-review.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

export async function startUncertainReviewUi(options: {
  loadItems: () => Promise<UncertainReviewItem[]>;
  port?: number;
}) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.slice(7) || !request.url) {
        return json(response, 403, { error: "Invalid host" });
      }
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/"
        && url.searchParams.get("token") === token) {
        const nonce = randomBytes(16).toString("base64");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        response.end(page(token, nonce));
        return;
      }
      if (request.method !== "GET" || request.headers["x-openapply-token"] !== token) {
        return json(response, 403, { error: "Review authorization failed" });
      }
      if (url.pathname !== "/api/uncertain") return json(response, 404, { error: "Unknown route" });
      return json(response, 200, { items: await options.loadItems() });
    } catch {
      return json(response, 500, { error: "Unable to load private application state" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${origin}/?token=${token}`, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}

function page(token: string, nonce: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenApply · Review uncertain submissions</title><style nonce="${nonce}">
:root{font:16px/1.5 system-ui,sans-serif;color:#17323c;background:#f7f3e9}*{box-sizing:border-box}body{margin:0}
main{max-width:850px;margin:6vh auto;padding:24px}h1{font:normal clamp(34px,6vw,56px)/1.05 Georgia,serif;margin:8px 0 20px}
.eyebrow{letter-spacing:.15em;text-transform:uppercase;color:#aa4d2b;font-size:13px;font-weight:700}
.card{background:#fff;padding:24px;border:1px solid #b8c1bd;margin:16px 0;overflow-wrap:anywhere}
.label{font-weight:700;margin:14px 0 0}.value{margin:2px 0 10px;white-space:pre-wrap}
.hint{color:#51676e}.path{font-family:ui-monospace,monospace;font-size:14px}
button{padding:10px 18px;background:#17323c;color:#fff;border:0;font:inherit;cursor:pointer}
button:focus-visible{outline:3px solid #b95431;outline-offset:2px}
@media(max-width:700px){main{margin:0;padding:16px}.card{padding:18px}}
</style><main><div class="eyebrow">OpenApply / Private review</div><h1>Check uncertain submissions.</h1>
<p>A final click may have occurred, but OpenApply has no verified employer confirmation. Check the employer portal or receipt before taking further action. Do not submit the form again.</p>
<button id="refresh" type="button">Refresh list</button><p id="status" role="status" aria-live="polite">Loading…</p><div id="items"></div></main>
<script nonce="${nonce}">
const token=${JSON.stringify(token)};
const status=document.getElementById('status'),items=document.getElementById('items');
function line(card,label,value,css='value'){const heading=document.createElement('p');heading.className='label';heading.textContent=label;card.append(heading);const text=document.createElement('p');text.className=css;text.textContent=value;card.append(text)}
async function refresh(){status.textContent='Loading…';const response=await fetch('/api/uncertain',{headers:{'x-openapply-token':token}});const data=await response.json();if(!response.ok){status.textContent=data.error;return}items.replaceChildren();status.textContent=data.items.length+' uncertain submission'+(data.items.length===1?'':'s')+' to review.';for(const item of data.items){const card=document.createElement('section');card.className='card';const title=document.createElement('h2');title.textContent=item.jobLabel;card.append(title);line(card,'Job ID',item.jobId);line(card,'Exact blocker',item.blocker);line(card,'Official posting',item.officialUrl);line(card,'Saved application package',item.packagePath||'No saved package path');if(item.browserPageUrl)line(card,'Last browser page',item.browserPageUrl);line(card,'Last updated',item.updatedAt);line(card,'Next step','Check the employer portal or confirmation email for this exact job. Record success only from an explicit employer confirmation; if none exists, keep this application under review.','value hint');items.append(card)}}
document.getElementById('refresh').addEventListener('click',()=>{refresh().catch(()=>{status.textContent='Unable to load private application state'})});
refresh().catch(()=>{status.textContent='Unable to load private application state'});
</script>`;
}
