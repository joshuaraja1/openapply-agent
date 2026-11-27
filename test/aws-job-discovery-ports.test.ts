import { describe, expect, it, vi } from "vitest";
import { BatchGetCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AwsJobDiscoveryPorts } from "../src/hosted/aws-job-discovery-ports.js";
import { sourceKey } from "../src/cloud/official-lead-sync.js";

const source = { provider: "greenhouse" as const, boardToken: "acme", company: "Acme" };
const config = JSON.stringify({ version: 1, sources: [source], maxJobsPerSource: 50 });
const candidateId = "91216845-7f44-5bd6-8357-885548676078";
const artifactId = "e6846107-caf1-54e2-9e46-a7d535623fd2";

describe("AWS job discovery read boundary", () => {
  it("reads only the signed-in job seeker's verified profile and configured source partition", async () => {
    const vault = { read: vi.fn(async () => Buffer.from("private profile")) };
    const send = vi.fn(async (command: GetCommand | QueryCommand) => {
      if (command instanceof GetCommand) return { Item: undefined };
      const input = command.input;
      if (input.ExpressionAttributeValues?.[":profile"] === "PROFILE#") return { Items: [{
        pk: `CANDIDATE#${candidateId}`, sk: `PROFILE#${artifactId}`,
        status: "verified", candidateId, artifactId, subjectId: "subject-a", verifiedAtEpoch: 100,
      }] };
      return { Items: [] };
    });
    const ports = new AwsJobDiscoveryPorts({ send } as never, vault, "ledger", config);
    expect(Buffer.from((await ports.loadReviewedProfile(candidateId, "subject-a"))! ).toString()).toBe("private profile");
    expect(vault.read).toHaveBeenCalledWith(candidateId, artifactId);
    expect(await ports.loadOfficialLeads()).toEqual([]);
    const sourceQuery = send.mock.calls.find(([command]) => command instanceof QueryCommand
      && command.input.ExpressionAttributeValues?.[":lead"] === "LEAD#")?.[0] as QueryCommand;
    expect(sourceQuery.input.ExpressionAttributeValues?.[":pk"]).toBe(sourceKey(source));
    expect(await ports.loadReviewedProfile(candidateId, "subject-b")).toBeUndefined();
    expect(vault.read).toHaveBeenCalledTimes(1);
  });

  it("refuses a deleted account and an unbounded source configuration", async () => {
    const vault = { read: vi.fn(async () => Buffer.from("private profile")) };
    const send = vi.fn(async () => ({ Item: { pk: `CANDIDATE#${candidateId}`, sk: "DELETED" } }));
    const ports = new AwsJobDiscoveryPorts({ send } as never, vault, "ledger", config);
    expect(await ports.loadReviewedProfile(candidateId, "subject-a")).toBeUndefined();
    expect(vault.read).not.toHaveBeenCalled();
    expect(() => new AwsJobDiscoveryPorts({ send } as never, vault, "ledger",
      JSON.stringify({ version: 1, sources: [source], maxJobsPerSource: 51 }))).toThrow();
  });

  it("reads at most 50 members in one batch and fails closed above that bound", async () => {
    const ids = Array.from({ length: 50 }, (_, i) =>
      `00000000-0000-5000-8000-${String(i).padStart(12, "0")}`);
    const send = vi.fn(async (command: QueryCommand | BatchGetCommand) => {
      if (command instanceof QueryCommand) return { Items: ids.map(id => ({
        pk: sourceKey(source), sk: `LEAD#${id}`, leadId: id,
      })) };
      return { Responses: { ledger: [] } };
    });
    const ports = new AwsJobDiscoveryPorts({ send } as never,
      { read: vi.fn() } as never, "ledger", config);
    expect(await ports.loadOfficialLeads()).toEqual([]);
    const batch = send.mock.calls.find(([command]) => command instanceof BatchGetCommand)?.[0] as BatchGetCommand;
    expect(batch.input.RequestItems?.ledger?.Keys).toHaveLength(50);
    expect(send.mock.calls.filter(([command]) => command instanceof BatchGetCommand)).toHaveLength(1);
    const tooMany = new AwsJobDiscoveryPorts({ send: vi.fn(async () => ({
      Items: Array.from({ length: 51 }, (_, i) => ({ pk: sourceKey(source), sk: `LEAD#${i}`, leadId: ids[0] })),
    })) } as never, { read: vi.fn() } as never, "ledger", config);
    await expect(tooMany.loadOfficialLeads()).rejects.toThrow("bound");
  });
});
