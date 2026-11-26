/** Single-tenant wake service. Candidate data and browser sessions never enter this Worker. */
async function authorized(request, token) {
  if (!token || token.length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(suppliedHash);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export default {
  async scheduled(controller, env) {
    if (!env.DB) throw new Error("Wake database is not bound");
    const issuedAt = new Date(controller.scheduledTime).toISOString();
    const result = await env.DB.prepare(
      "UPDATE wake SET generation = generation + 1, issued_at = ? WHERE id = 1",
    ).bind(issuedAt).run();
    if (!result.success || result.meta?.changes !== 1) throw new Error("Wake update failed");
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/tick" || request.method !== "GET") return json({ error: "not_found" }, 404);
    if (!await authorized(request, env.OPENAPPLY_AGENT_TOKEN)) return json({ error: "unauthorized" }, 401);
    if (!env.DB) return json({ error: "unavailable" }, 503);
    try {
      const row = await env.DB.prepare(
        "SELECT generation, issued_at AS issuedAt FROM wake WHERE id = 1",
      ).first();
      if (!row || !Number.isSafeInteger(row.generation) || row.generation < 0) {
        return json({ error: "unavailable" }, 503);
      }
      return json({ generation: row.generation, issuedAt: row.issuedAt });
    } catch {
      return json({ error: "unavailable" }, 503);
    }
  },
};
