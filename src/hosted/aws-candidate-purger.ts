import { S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { candidatePrefix } from "../cloud/candidate-vault.js";
import { S3ArtifactStore } from "../cloud/aws-artifact-store.js";

/** The Lambda has no direct S3 grants. The assumed role's session policy
 * intersects its ceiling with one verified candidate prefix per purge. */
export function candidatePurgeSessionPolicy(candidateId: string, bucket: string) {
  const prefix = candidatePrefix(candidateId);
  if (!bucket || !/^[a-z0-9.-]+$/.test(bucket)) throw new Error("Invalid artifact bucket");
  return { Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: "s3:ListBucketVersions",
      Resource: `arn:aws:s3:::${bucket}`,
      Condition: { StringLike: { "s3:prefix": `${prefix}*` } } },
    { Effect: "Allow", Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      Resource: `arn:aws:s3:::${bucket}/${prefix}*` },
  ] } as const;
}

export class AssumeRoleCandidatePurger {
  constructor(private readonly sts: Pick<STSClient, "send">,
    private readonly roleArn: string, private readonly bucket: string) {
    if (!/^arn:aws[^:]*:iam::[0-9]{12}:role\//.test(roleArn)) throw new Error("Invalid purge role");
  }

  async deleteCandidate(candidateId: string): Promise<void> {
    const prefix = candidatePrefix(candidateId);
    const assumed = await this.sts.send(new AssumeRoleCommand({ RoleArn: this.roleArn,
      RoleSessionName: "candidate-purge",
      DurationSeconds: 900,
      Policy: JSON.stringify(candidatePurgeSessionPolicy(candidateId, this.bucket)) }));
    const credentials = assumed.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error("Purge role did not return temporary credentials");
    }
    const client = new S3Client({ credentials: { accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } });
    try { await new S3ArtifactStore(client, this.bucket).purgeVersions(prefix, false); }
    finally { client.destroy(); }
  }
}
