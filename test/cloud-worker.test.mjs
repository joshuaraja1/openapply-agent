import { describe, expect, it } from "vitest";
import worker from "../cloud/worker.mjs";

function fixture() {
  const row = { generation: 0, issuedAt: "1970-01-01T00:00:00.000Z" };
  const env = { OPENAPPLY_AGENT_TOKEN: "t".repeat(48), DB: {
    prepare(sql) { return {
      bind(issuedAt) { expect(sql).toContain("UPDATE wake"); return {
        async run() { row.generation++; row.issuedAt = issuedAt;
          return { success: true, meta: { changes: 1 } }; },
      }; },
      async first() { expect(sql).toContain("SELECT generation"); return row; },
    }; },
  } };
  return { env, row };
}

describe("Cloudflare wake Worker", () => {
  it("exposes only an authenticated, uncached tick", async () => {
    const { env } = fixture();
    const url = "https://openapply.example/v1/tick";
    expect((await worker.fetch(new Request(url), env)).status).toBe(401);
    expect((await worker.fetch(new Request(url, { headers: { authorization: "Bearer wrong" } }), env)).status).toBe(401);
    expect((await worker.fetch(new Request("https://openapply.example/other"), env)).status).toBe(404);
    await worker.scheduled({ scheduledTime: Date.parse("2026-11-26T12:00:00Z") }, env);
    const result = await worker.fetch(new Request(url, {
      headers: { authorization: `Bearer ${env.OPENAPPLY_AGENT_TOKEN}` },
    }), env);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ generation: 1, issuedAt: "2026-11-26T12:00:00.000Z" });
  });

  it("fails closed when the wake database is unavailable", async () => {
    const env = { OPENAPPLY_AGENT_TOKEN: "t".repeat(48) };
    const result = await worker.fetch(new Request("https://openapply.example/v1/tick", {
      headers: { authorization: `Bearer ${env.OPENAPPLY_AGENT_TOKEN}` },
    }), env);
    expect(result.status).toBe(503);
    await expect(worker.scheduled({ scheduledTime: Date.now() }, env)).rejects.toThrow("database");
  });
});
