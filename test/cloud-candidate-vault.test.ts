import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  artifactObjectKey, CandidateVault, type ArtifactStorePort, type DataKeyPort,
} from "../src/cloud/candidate-vault.js";
import { S3ArtifactStore } from "../src/cloud/aws-artifact-store.js";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const resume = "10000000-0000-4000-8000-000000000001";
const profile = "10000000-0000-4000-8000-000000000002";

class FakeKeys implements DataKeyPort {
  private readonly keys = new Map<string, { key: Buffer; context: string }>();
  generatedKey?: Buffer;
  unwrapCalls = 0;

  async generate(context: Record<string, string>) {
    const key = randomBytes(32);
    const wrapped = randomBytes(32);
    this.keys.set(wrapped.toString("hex"), { key: Buffer.from(key), context: JSON.stringify(context) });
    this.generatedKey = key;
    return { plaintext: key, wrapped };
  }

  async unwrap(wrapped: Uint8Array, context: Record<string, string>) {
    this.unwrapCalls++;
    const record = this.keys.get(Buffer.from(wrapped).toString("hex"));
    if (!record || record.context !== JSON.stringify(context)) throw new Error("KMS encryption context mismatch");
    return Buffer.from(record.key);
  }
}

class FakeObjects implements ArtifactStorePort {
  readonly versions = new Map<string, Uint8Array[]>();
  async put(key: string, body: Uint8Array) {
    this.versions.set(key, [...(this.versions.get(key) ?? []), Buffer.from(body)]);
  }
  async get(key: string) {
    const versions = this.versions.get(key);
    if (!versions?.length) throw new Error("No such encrypted object");
    return Buffer.from(versions[versions.length - 1]!);
  }
  async purgeVersions(prefix: string, exactKey: boolean) {
    for (const key of this.versions.keys()) {
      if (exactKey ? key === prefix : key.startsWith(prefix)) this.versions.delete(key);
    }
  }
}

describe("cloud candidate vault", () => {
  it("encrypts artifacts with an authenticated tenant and artifact identity", async () => {
    const keys = new FakeKeys();
    const objects = new FakeObjects();
    const vault = new CandidateVault(keys, objects);
    await vault.put(alice, resume, Buffer.from("approved resume"));
    const stored = Buffer.from((await objects.get(artifactObjectKey(alice, resume)))).toString("utf8");
    expect(stored).not.toContain("approved resume");
    expect(keys.generatedKey).toEqual(Buffer.alloc(32));
    const plaintext = await vault.read(alice, resume);
    expect(plaintext.toString()).toBe("approved resume");
    plaintext.fill(0);
  });

  it("rejects ciphertext tampering and a copied object under another candidate", async () => {
    const keys = new FakeKeys();
    const objects = new FakeObjects();
    const vault = new CandidateVault(keys, objects);
    await vault.put(alice, resume, Buffer.from("private history"));
    const aliceBody = JSON.parse(Buffer.from(await objects.get(artifactObjectKey(alice, resume))).toString());
    const corrupted = Buffer.from(aliceBody.ciphertext, "base64");
    corrupted[0] = corrupted[0]! ^ 1;
    aliceBody.ciphertext = corrupted.toString("base64");
    await objects.put(artifactObjectKey(alice, resume), Buffer.from(JSON.stringify(aliceBody)));
    await expect(vault.read(alice, resume)).rejects.toThrow();

    await objects.put(artifactObjectKey(bob, resume), Buffer.from(JSON.stringify(aliceBody)));
    const before = keys.unwrapCalls;
    await expect(vault.read(bob, resume)).rejects.toThrow("identity");
    expect(keys.unwrapCalls).toBe(before);
    aliceBody.candidateId = bob;
    await objects.put(artifactObjectKey(bob, resume), Buffer.from(JSON.stringify(aliceBody)));
    await expect(vault.read(bob, resume)).rejects.toThrow("context mismatch");
  });

  it("rejects unsafe IDs before selecting any object key", async () => {
    const vault = new CandidateVault(new FakeKeys(), new FakeObjects());
    await expect(vault.read("../other-candidate", resume)).rejects.toThrow();
    await expect(vault.deleteCandidate(alice.toUpperCase())).rejects.toThrow();
  });

  it("restores into a private temporary file and removes it on cleanup", async () => {
    const vault = new CandidateVault(new FakeKeys(), new FakeObjects());
    await vault.put(alice, profile, Buffer.from("profile snapshot"));
    const restored = await vault.restoreToPrivateTemp(alice, profile);
    expect((await readFile(restored.path)).toString()).toBe("profile snapshot");
    if (process.platform !== "win32") {
      expect((await stat(restored.path)).mode & 0o077).toBe(0);
    }
    await restored.cleanup();
    await expect(stat(restored.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes all candidate versions while preserving another tenant", async () => {
    const objects = new FakeObjects();
    const vault = new CandidateVault(new FakeKeys(), objects);
    await vault.put(alice, resume, Buffer.from("v1"));
    await vault.put(alice, resume, Buffer.from("v2"));
    await vault.put(alice, profile, Buffer.from("profile"));
    await vault.put(bob, resume, Buffer.from("bob"));
    await vault.deleteArtifact(alice, resume);
    expect(objects.versions.has(artifactObjectKey(alice, resume))).toBe(false);
    await vault.deleteCandidate(alice);
    expect([...objects.versions.keys()]).toEqual([artifactObjectKey(bob, resume)]);
  });
});

describe("S3 version purge", () => {
  it("reads a bounded encrypted object stream", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected AWS command");
      return {
        ContentLength: 4,
        Body: { transformToWebStream: () => new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("ab"));
            controller.enqueue(Buffer.from("cd"));
            controller.close();
          },
        }) },
      };
    });
    const store = new S3ArtifactStore({ send } as unknown as S3Client, "private-bucket");
    expect(Buffer.from(await store.get(artifactObjectKey(alice, resume))).toString()).toBe("abcd");
  });

  it("walks all version and delete-marker pages but deletes only the exact key", async () => {
    const key = artifactObjectKey(alice, resume);
    const deleted: { Key?: string | undefined; VersionId?: string | undefined }[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) {
        if (!command.input.KeyMarker) return {
          Versions: [{ Key: key, VersionId: "v2" }, { Key: key + "-other", VersionId: "wrong" }],
          IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "v2",
        };
        return { Versions: [{ Key: key, VersionId: "v1" }],
          DeleteMarkers: [{ Key: key, VersionId: "deleted" }], IsTruncated: false };
      }
      if (command instanceof DeleteObjectsCommand) {
        deleted.push(...(command.input.Delete?.Objects ?? []));
        return {};
      }
      throw new Error("Unexpected AWS command");
    });
    const store = new S3ArtifactStore({ send } as unknown as S3Client, "private-bucket");
    await store.purgeVersions(key, true);
    expect(deleted).toEqual([
      { Key: key, VersionId: "v2" },
      { Key: key, VersionId: "v1" },
      { Key: key, VersionId: "deleted" },
    ]);
  });

  it("does not accept a stalled paginated listing or partial deletion", async () => {
    const key = artifactObjectKey(alice, resume);
    const stalled = new S3ArtifactStore({ send: async () => ({
      IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: "v1",
    }) } as unknown as S3Client, "private-bucket");
    await expect(stalled.purgeVersions(key, true)).rejects.toThrow("did not advance");

    const failed = new S3ArtifactStore({ send: async (command: unknown) =>
      command instanceof ListObjectVersionsCommand
        ? { Versions: [{ Key: key, VersionId: "v1" }], IsTruncated: false }
        : { Errors: [{ Key: key, VersionId: "v1" }] },
    } as unknown as S3Client, "private-bucket");
    await expect(failed.purgeVersions(key, true)).rejects.toThrow("could not delete");
  });

  it("purges all versions for one candidate prefix without touching another", async () => {
    const prefix = `candidates/${alice}/`;
    const other = artifactObjectKey(bob, resume);
    const deleted: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListObjectVersionsCommand) return {
        Versions: [
          { Key: artifactObjectKey(alice, resume), VersionId: "v1" },
          { Key: artifactObjectKey(alice, profile), VersionId: "v2" },
          { Key: other, VersionId: "foreign" },
        ],
        IsTruncated: false,
      };
      if (command instanceof DeleteObjectsCommand) {
        deleted.push(...(command.input.Delete?.Objects ?? []).map((item) => item.Key ?? ""));
        return {};
      }
      throw new Error("Unexpected AWS command");
    });
    const store = new S3ArtifactStore({ send } as unknown as S3Client, "private-bucket");
    await store.purgeVersions(prefix, false);
    expect(deleted.sort()).toEqual([artifactObjectKey(alice, resume), artifactObjectKey(alice, profile)].sort());
  });
});
