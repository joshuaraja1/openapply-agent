# Candidate-bound artifact access

`TenantBoundCandidateVault` binds each artifact call to one lowercase candidate
ID, run ID, and lease token. It rejects calls for another candidate before
reaching the underlying vault and requires a trusted access fence for every
read, write, or deletion operation. The fence must hold authorization for the
whole operation, not merely check it once at startup.

This is a **code-level guard**, not AWS authorization. The staging module has no
production fence implementation and is not wired to an ECS task. Before real
candidate data, use a trusted credential broker or scoped AWS credentials so a
compromised task cannot read another candidate's S3 prefix or use KMS to unwrap
their key even if it knows that candidate's UUID. Test cross-candidate denial
at the IAM/S3/KMS boundary in a live staging account.

Account deletion requires a stronger fence: write a durable tombstone, stop
and await active workers, revoke further writes, and only then purge all S3
versions. S3 deletion and DynamoDB tombstoning are not atomic. The guard
interface deliberately leaves this work to its trusted implementation; no
live deletion is enabled by this slice.
