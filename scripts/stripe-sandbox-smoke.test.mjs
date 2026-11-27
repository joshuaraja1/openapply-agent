import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupSandboxCustomer } from "./stripe-sandbox-smoke.mjs";

function harness({ expireFails = false, deleteFails = false } = {}) {
  const calls = [];
  let open = [{ id: "cs_test_lost_after_create", status: "open" }];
  const stripe = {
    checkout: { sessions: {
      list: async (query) => {
        calls.push(["list", query]);
        return { data: query.status === "open" ? open : [...open], has_more: false };
      },
      expire: async (id) => {
        calls.push(["expire", id]);
        if (expireFails) throw new Error("simulated Stripe failure");
        open = open.filter(s => s.id !== id);
      },
    } },
    customers: { del: async (id) => {
      calls.push(["delete", id]);
      if (deleteFails) throw new Error("simulated Stripe failure");
      return { id, deleted: true };
    } },
  };
  return { stripe, calls };
}

test("sweeps a session lost before local record and confirms cleanup", async () => {
  const { stripe, calls } = harness();
  await cleanupSandboxCustomer(stripe, "cus_test_1");
  assert.deepEqual(calls.filter(c => c[0] === "expire"), [["expire", "cs_test_lost_after_create"]]);
  assert.deepEqual(calls.at(-1), ["delete", "cus_test_1"]);
});

test("fails and preserves Customer when expiration leaves an open session", async () => {
  const { stripe, calls } = harness({ expireFails: true });
  await assert.rejects(cleanupSandboxCustomer(stripe, "cus_test_1"), /cs_test_lost_after_create/);
  assert.equal(calls.some(c => c[0] === "delete"), false);
});

test("fails when Stripe does not confirm Customer deletion", async () => {
  const { stripe } = harness({ deleteFails: true });
  await assert.rejects(cleanupSandboxCustomer(stripe, "cus_test_1"), /Customer cleanup incomplete/);
});
