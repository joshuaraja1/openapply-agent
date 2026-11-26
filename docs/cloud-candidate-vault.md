# Cloud candidate artifact vault

Status: staging foundation only. The live application runner still uses its
existing local private files. No candidate data has been moved to AWS.

`CandidateVault` encrypts each artifact with a fresh AES-256-GCM data key from
KMS before sending it to the private, versioned S3 bucket in the cloud control
plane. The KMS encryption context and AES authenticated data bind the key and
ciphertext to the lowercase candidate UUID and artifact UUID. S3 keys are
derived from validated UUIDs; caller-supplied paths are never accepted.
An artifact UUID is create-only while the S3 key exists: a conditional write
rejects a second current object. A changed résumé or browser profile needs a
fresh artifact UUID and a durable journal update pointing to it. S3 allows a
new conditional write after a delete marker, so the durable journal must also
reject reuse of an artifact UUID after deletion before this is used for
immutable receipt evidence.

Construct the vault with `KmsDataKeys(KMSClient, key ARN)` and
`S3ArtifactStore(S3Client, private bucket name)`. Supply a task role that has
only the required KMS key and bucket permissions. The shared service role
must never trust a candidate ID from a browser page or queue message alone:
authenticate the caller, acquire its candidate lease, and check ownership
before calling this API. The task role's KMS and S3 permissions still need a
tenant-isolation review in the actual ECS deployment.

`restoreToPrivateTemp` writes a private file and returns an explicit cleanup
function. The caller must invoke cleanup after loading it. The task's
ephemeral disk is an additional cleanup boundary on termination. This staging
implementation limits plaintext to 64 MiB and reads one artifact in memory;
large browser-profile snapshots need a streaming format before production.

`deleteArtifact` and `deleteCandidate` list and remove **every S3 object
version and delete marker**, not merely add a new delete marker. Before
deleting a candidate, revoke new writes and wait for or terminate active
candidate tasks. Also remove queue entries, journal records, backups, and
retained audit data according to the product deletion policy. A completed S3
purge alone is not complete account deletion.
