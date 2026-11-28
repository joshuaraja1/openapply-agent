import { describe, expect, it, vi } from "vitest";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand,
  type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cleanupFixture, createFixtureManifest, validateManifest }
  from "../src/cloud/aws-synthetic-drill-fixture-cli.js";
import type { CandidateVault } from "../src/cloud/candidate-vault.js";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Oh1ATVXu8";
function manifest() {
  let next = 0;
  return createFixtureManifest(issuer, new Date("2026-11-28T00:00:00Z"), () =>
    `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`);
}

describe("disposable cloud fixture", () => {
  it("derives two distinct seekers and rejects a manifest aimed at another subject", () => {
    const value = manifest();
    expect(value.seekers.map(seeker => seeker.runs.length)).toEqual([2, 1]);
    expect(validateManifest(value, issuer)).toBe(value);
    expect(() => validateManifest({ ...value, seekers: [
      { ...value.seekers[0], subjectId: "real-account" }, value.seekers[1],
    ] }, issuer)).toThrow("manifest is invalid");
    expect(() => validateManifest({ ...value, seekers: [value.seekers[0],
      { ...value.seekers[1], candidateId: value.seekers[0].candidateId },
    ] }, issuer)).toThrow("manifest is invalid");
  });

  it("retains deletion fences, refuses active tasks, and cleans up idempotently", async () => {
    const value = manifest();
    const rows = new Map<string, Record<string, unknown>>();
    const key = (table: string, pk: string, sk: string) => `${table}|${pk}|${sk}`;
    for (const seeker of value.seekers) {
      rows.set(key("ledger", `CANDIDATE#${seeker.candidateId}`,
        `PROFILE#${seeker.profileArtifactId}`),
      { pk: `CANDIDATE#${seeker.candidateId}`, sk: `PROFILE#${seeker.profileArtifactId}`,
        candidateId: seeker.candidateId, artifactId: seeker.profileArtifactId,
        subjectId: seeker.subjectId });
      rows.set(key("entitlements", `SUBJECT#${seeker.subjectId}`,
        `ENTITLEMENT#${seeker.grantId}`), { pk: `SUBJECT#${seeker.subjectId}`,
        sk: `ENTITLEMENT#${seeker.grantId}`, record: { subjectId: seeker.subjectId,
          grantId: seeker.grantId, approvedBy: "staging-synthetic-drill" } });
      for (const run of seeker.runs) rows.set(key("ledger", `LEAD#${run.leadId}`, "VERIFIED"),
        { pk: `LEAD#${run.leadId}`, sk: "VERIFIED", job: { provider: "synthetic",
          employerId: "fixture", requisitionId: run.requisitionId } });
    }
    const activeKey = key("ledger", `CANDIDATE#${value.seekers[0].candidateId}`, "ACTIVE_TASK");
    rows.set(activeKey, { pk: `CANDIDATE#${value.seekers[0].candidateId}`, sk: "ACTIVE_TASK" });
    const send = vi.fn(async (command: PutCommand | GetCommand | QueryCommand | DeleteCommand) => {
      const table = command.input.TableName === "openapply-staging-run-ledger" ? "ledger" : "entitlements";
      if (command instanceof PutCommand) {
        const item = command.input.Item as Record<string, unknown>;
        const location = key(table, item.pk as string, item.sk as string);
        if (rows.has(location)) throw Object.assign(new Error("exists"),
          { name: "ConditionalCheckFailedException" });
        rows.set(location, item);
        return {};
      }
      if (command instanceof GetCommand) {
        const item = command.input.Key as { pk: string; sk: string };
        return { Item: rows.get(key(table, item.pk, item.sk)) };
      }
      if (command instanceof QueryCommand) {
        const pk = command.input.ExpressionAttributeValues?.[":pk"] as string;
        return { Items: [...rows.values()].filter(item => item.pk === pk) };
      }
      if (command instanceof DeleteCommand) {
        const item = command.input.Key as { pk: string; sk: string };
        rows.delete(key(table, item.pk, item.sk));
        return {};
      }
      throw new Error("Unexpected command");
    });
    const db = { send } as unknown as Pick<DynamoDBDocumentClient, "send">;
    const vault = { deleteCandidate: vi.fn(async () => {}) } as unknown as Pick<CandidateVault,
      "deleteCandidate">;
    await expect(cleanupFixture(value, db, vault)).rejects.toThrow("still active");
    expect(vault.deleteCandidate).not.toHaveBeenCalled();
    rows.delete(activeKey);
    const slotKey = key("ledger", "LAUNCHER#staging", "SLOT#1");
    rows.set(slotKey, { pk: "LAUNCHER#staging", sk: "SLOT#1" });
    await expect(cleanupFixture(value, db, vault)).rejects.toThrow("still reserved");
    expect(vault.deleteCandidate).not.toHaveBeenCalled();
    rows.delete(slotKey);
    const unrelatedKey = key("ledger", `CANDIDATE#${value.seekers[0].candidateId}`,
      "UNRELATED#row");
    rows.set(unrelatedKey, { pk: `CANDIDATE#${value.seekers[0].candidateId}`,
      sk: "UNRELATED#row" });
    await expect(cleanupFixture(value, db, vault)).rejects.toThrow("Unexpected row");
    expect(vault.deleteCandidate).not.toHaveBeenCalled();
    rows.delete(unrelatedKey);
    const profileKey = key("ledger", `CANDIDATE#${value.seekers[0].candidateId}`,
      `PROFILE#${value.seekers[0].profileArtifactId}`);
    rows.set(profileKey, { ...rows.get(profileKey), subjectId: "someone-else" });
    await expect(cleanupFixture(value, db, vault)).rejects.toThrow("provenance changed");
    expect(vault.deleteCandidate).not.toHaveBeenCalled();
    rows.set(profileKey, { ...rows.get(profileKey), subjectId: value.seekers[0].subjectId });
    await cleanupFixture(value, db, vault);
    await cleanupFixture(value, db, vault);
    expect(vault.deleteCandidate).toHaveBeenCalledTimes(4);
    for (const seeker of value.seekers) {
      expect(rows.has(key("ledger", `CANDIDATE#${seeker.candidateId}`, "DELETED"))).toBe(true);
      expect([...rows.keys()].filter(item => item.includes(seeker.subjectId)
        || seeker.runs.some(run => item.includes(run.leadId)))).toEqual([]);
    }
  });
});
