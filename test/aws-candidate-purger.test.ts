import { describe, expect, it, vi } from "vitest";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { AssumeRoleCandidatePurger, candidatePurgeSessionPolicy } from "../src/hosted/aws-candidate-purger.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";

describe("candidate-scoped purge credentials", () => {
  it("narrows both S3 version listing and deletion to one candidate, including receipts", () => {
    const policy = candidatePurgeSessionPolicy(candidateId, "private-artifacts");
    const encoded = JSON.stringify(policy);
    expect(policy.Statement[0].Condition?.StringLike["s3:prefix"])
      .toBe(`candidates/${candidateId}/*`);
    expect(policy.Statement[1].Resource)
      .toBe(`arn:aws:s3:::private-artifacts/candidates/${candidateId}/*`);
    expect(encoded).not.toContain(otherId);
    expect(encoded).not.toContain("s3:GetObject");
    expect(encoded).not.toContain("kms:Decrypt");
    expect(encoded).not.toContain("s3:PutObject");
    // The wildcard after this candidate prefix covers artifacts and
    // runs/<runId>/receipts/<artifactId>, but no sibling candidate prefix.
    expect(`candidates/${candidateId}/runs/${otherId}/receipts/${otherId}`
      .startsWith(`candidates/${candidateId}/`)).toBe(true);
    expect(`candidates/${otherId}/runs/${otherId}/receipts/${otherId}`
      .startsWith(`candidates/${candidateId}/`)).toBe(false);
  });

  it("rejects malformed IDs before STS and sends only a narrow session policy", async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const purger = new AssumeRoleCandidatePurger({ send } as unknown as
      Pick<STSClient, "send">, "arn:aws:iam::123456789012:role/purge", "private-artifacts");
    await expect(purger.deleteCandidate("../other")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await expect(purger.deleteCandidate(candidateId)).rejects.toThrow("temporary credentials");
    const command = send.mock.calls[0]?.[0] as AssumeRoleCommand;
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    expect(JSON.parse(command.input.Policy!)).toEqual(candidatePurgeSessionPolicy(candidateId, "private-artifacts"));
    expect(command.input.RoleSessionName).toBe("candidate-purge");
  });
});
