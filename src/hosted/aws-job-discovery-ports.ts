import { BatchGetCommand, GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { CandidateVault } from "../cloud/candidate-vault.js";
import { officialLeadSyncConfigSchema, sourceKey, type OfficialLeadRow } from "../cloud/official-lead-sync.js";
import type { JobDiscoveryPorts } from "./job-discovery.js";

const marker = z.object({ pk: z.string(), sk: z.string(), status: z.literal("verified"),
  candidateId: z.uuid(), artifactId: z.uuid(), subjectId: z.string(),
  verifiedAtEpoch: z.number().int().positive() });
const member = z.object({ pk: z.string(), sk: z.string(), leadId: z.uuid() });

/** Reads only operator-configured official source partitions. The user supplies
 * neither source IDs nor lead IDs, and the query volume is bounded. */
export class AwsJobDiscoveryPorts implements JobDiscoveryPorts {
  private readonly sourceKeys: string[];
  constructor(private readonly db: Pick<DynamoDBDocumentClient, "send">,
    private readonly vault: Pick<CandidateVault, "read">,
    private readonly table: string, sourcesJson: string) {
    const config = officialLeadSyncConfigSchema.parse(JSON.parse(sourcesJson));
    if (!table || config.sources.length > 4 || config.maxJobsPerSource > 50) {
      throw new Error("Job discovery source bound exceeded");
    }
    this.sourceKeys = [...new Set(config.sources.map(sourceKey))];
  }

  async loadReviewedProfile(candidateId: string, subjectId: string): Promise<Uint8Array | undefined> {
    const pk = `CANDIDATE#${candidateId}`;
    const deleted = await this.db.send(new GetCommand({ TableName: this.table,
      Key: { pk, sk: "DELETED" }, ConsistentRead: true }));
    if (deleted.Item) return undefined;
    const result = await this.db.send(new QueryCommand({ TableName: this.table,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :profile)",
      ExpressionAttributeValues: { ":pk": pk, ":profile": "PROFILE#" },
      ConsistentRead: true, Limit: 26 }));
    if (result.LastEvaluatedKey || (result.Items?.length ?? 0) > 25) {
      throw new Error("Too many profile versions for bounded read");
    }
    const latest = (result.Items ?? []).flatMap(item => {
      const parsed = marker.safeParse(item);
      return parsed.success && parsed.data.pk === pk
        && parsed.data.sk === `PROFILE#${parsed.data.artifactId}`
        && parsed.data.candidateId === candidateId && parsed.data.subjectId === subjectId
        ? [parsed.data] : [];
    }).sort((a, b) => b.verifiedAtEpoch - a.verifiedAtEpoch)[0];
    if (!latest) return undefined;
    const plaintext = await this.vault.read(candidateId, latest.artifactId);
    // Deletion may race the read; do not display a profile after the tombstone.
    const after = await this.db.send(new GetCommand({ TableName: this.table,
      Key: { pk, sk: "DELETED" }, ConsistentRead: true }));
    if (after.Item) { plaintext.fill(0); return undefined; }
    return plaintext;
  }

  async loadOfficialLeads(): Promise<OfficialLeadRow[]> {
    const leads: OfficialLeadRow[] = [];
    for (const pk of this.sourceKeys) {
      const result = await this.db.send(new QueryCommand({ TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :lead)",
        ExpressionAttributeValues: { ":pk": pk, ":lead": "LEAD#" },
        ConsistentRead: true, Limit: 51 }));
      if (result.LastEvaluatedKey || (result.Items?.length ?? 0) > 50) {
        throw new Error("Official lead membership exceeded read bound");
      }
      const ids: string[] = [];
      for (const item of result.Items ?? []) {
        const parsed = member.safeParse(item);
        if (!parsed.success || parsed.data.pk !== pk
          || parsed.data.sk !== `LEAD#${parsed.data.leadId}`) continue;
        ids.push(parsed.data.leadId);
      }
      if (ids.length) {
        let keys = ids.map(id => ({ pk: `LEAD#${id}`, sk: "VERIFIED" }));
        for (let attempt = 0; keys.length && attempt < 3; attempt++) {
          const batch = await this.db.send(new BatchGetCommand({ RequestItems: {
            [this.table]: { Keys: keys, ConsistentRead: true },
          } }));
          for (const lead of batch.Responses?.[this.table] ?? []) {
            if (lead.sourceKey === pk && ids.includes(lead.leadId)
              && lead.pk === `LEAD#${lead.leadId}` && lead.sk === "VERIFIED") {
              leads.push(lead as OfficialLeadRow);
            }
          }
          keys = (batch.UnprocessedKeys?.[this.table]?.Keys ?? []) as typeof keys;
        }
        if (keys.length) throw new Error("Official lead batch read incomplete");
      }
    }
    return leads;
  }
}
