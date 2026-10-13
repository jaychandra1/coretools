import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  backupFileName,
  backupKindOf,
  BACKUP_PREFIXES,
  CloudSyncError,
  describeCloudError,
  detectConflict,
  MAX_VERSIONS,
  md5Hex,
  ofKind,
  performBackup,
  planPrune,
  retryDelayMs,
  sortNewestFirst,
  type BackupKind,
  type BackupTransport,
  type RemoteBackup,
} from "./cloud-sync";

function remote(
  id: string,
  minute: number,
  deviceId = "dev-a",
  kind: BackupKind = "authenticator",
): RemoteBackup {
  return {
    id,
    name: `${BACKUP_PREFIXES[kind]}${id}.json`,
    createdTime: new Date(Date.UTC(2026, 9, 11, 10, minute)).toISOString(),
    size: 100,
    md5Checksum: "",
    deviceId,
    deviceLabel: deviceId.toUpperCase(),
  };
}

/** In-memory transport that behaves like Drive's appDataFolder. */
class FakeTransport implements BackupTransport {
  files: Array<RemoteBackup & { content: string }> = [];
  removed: string[] = [];
  corruptChecksum = false;
  failUpload: string | null = null;
  #clock = 100;

  async list() {
    return this.files.map(({ content: _c, ...meta }) => meta);
  }
  async upload(file: { name: string; content: string; deviceId: string; deviceLabel: string }) {
    if (this.failUpload) throw this.failUpload;
    const stored = {
      id: `id-${this.files.length + 1}`,
      name: file.name,
      createdTime: new Date(Date.UTC(2026, 9, 11, 12, this.#clock++)).toISOString(),
      size: file.content.length,
      md5Checksum: this.corruptChecksum ? "deadbeef" : md5Hex(file.content),
      deviceId: file.deviceId,
      deviceLabel: file.deviceLabel,
      content: file.content,
    };
    this.files.push(stored);
    const { content: _c, ...meta } = stored;
    return meta;
  }
  async remove(id: string) {
    this.removed.push(id);
    this.files = this.files.filter((f) => f.id !== id);
  }
}

describe("naming & ordering", () => {
  it("builds sortable, transport-safe file names per series", () => {
    const at = new Date("2026-10-11T10:30:00.123Z");
    const name = backupFileName("authenticator", at, "1a2b3c4d-5e6f");
    expect(name).toBe("coretools-authenticator-20261011T103000123Z-1a2b3c4d.json");
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(backupFileName("credmanager", at, "1a2b3c4d-5e6f")).toBe(
      "coretools-credmanager-20261011T103000123Z-1a2b3c4d.json",
    );
  });

  it("tells the series apart by file name", () => {
    expect(backupKindOf("coretools-authenticator-x.json")).toBe("authenticator");
    expect(backupKindOf("coretools-credmanager-x.json")).toBe("credmanager");
    expect(backupKindOf("something-else.json")).toBeNull();
    const list = [remote("a", 1), remote("c", 2, "dev-a", "credmanager"), remote("b", 3)];
    expect(ofKind(list, "authenticator").map((f) => f.id)).toEqual(["a", "b"]);
    expect(ofKind(list, "credmanager").map((f) => f.id)).toEqual(["c"]);
  });

  it("sorts newest first", () => {
    const sorted = sortNewestFirst([remote("a", 1), remote("c", 3), remote("b", 2)]);
    expect(sorted.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });

  it("prunes everything beyond the newest N", () => {
    const list = Array.from({ length: 13 }, (_, i) => remote(`v${i}`, i));
    expect(planPrune(list, 10)).toEqual(["v2", "v1", "v0"]);
    expect(planPrune(list.slice(0, 3), 10)).toEqual([]);
  });
});

describe("md5Hex", () => {
  it("matches node:crypto (Drive's md5Checksum is lowercase hex)", () => {
    for (const text of ["", "abc", '{"format":"x","ü":"ß"}', "x".repeat(1000)]) {
      expect(md5Hex(text)).toBe(createHash("md5").update(text, "utf8").digest("hex"));
    }
  });
});

describe("detectConflict", () => {
  const mine = "dev-me";

  it("is safe with no remote backups", () => {
    expect(detectConflict([], null, mine)).toBeNull();
  });

  it("is safe when the newest version is the one we're based on", () => {
    expect(detectConflict([remote("x", 1, "dev-other"), remote("y", 2, "dev-other")], "y", mine)).toBeNull();
  });

  it("is safe when the newest version is our own", () => {
    expect(detectConflict([remote("x", 1, "dev-other"), remote("y", 2, mine)], "x", mine)).toBeNull();
  });

  it("flags a newer version from another device", () => {
    const list = [remote("x", 1, mine), remote("y", 2, "dev-other")];
    expect(detectConflict(list, "x", mine)?.id).toBe("y");
  });

  it("flags existing backups on a freshly connected device", () => {
    expect(detectConflict([remote("x", 1, "dev-other")], null, mine)?.id).toBe("x");
  });
});

describe("retryDelayMs", () => {
  it("backs off and caps at 15 minutes", () => {
    expect(retryDelayMs(0)).toBe(15_000);
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(6)).toBe(900_000);
    expect(retryDelayMs(99)).toBe(900_000);
  });
});

describe("describeCloudError", () => {
  it("maps Rust error tokens to friendly, non-leaky messages", () => {
    expect(describeCloudError("cloud_network")).toMatchObject({ kind: "network", retryable: true });
    expect(describeCloudError("cloud_auth_revoked")).toMatchObject({ kind: "auth", retryable: false });
    expect(describeCloudError("oauth_canceled")).toMatchObject({ kind: "canceled", message: "" });
    expect(describeCloudError("hello_canceled").kind).toBe("canceled");
    expect(describeCloudError("cloud_quota").kind).toBe("quota");
    expect(describeCloudError("oauth_scope_denied").kind).toBe("auth");
    expect(describeCloudError("cloud_http_418").message).not.toContain("418");
    expect(describeCloudError("cloud_domain_policy").message).toMatch(/administrator/);
    // An unrecognised 403 must not be treated as revoked access (F-22): that
    // would stop backups and push every user to reconnect.
    expect(describeCloudError("cloud_http_403")).toMatchObject({ kind: "other", retryable: false });
    expect(describeCloudError(new CloudSyncError("cloud_integrity", "x")).retryable).toBe(true);
  });

  it("tolerates detail suffixes and unknown tokens", () => {
    expect(describeCloudError("oauth_listen_failed: address in use").kind).toBe("other");
    const unknown = describeCloudError("something_weird");
    expect(unknown.kind).toBe("other");
    expect(unknown.message).not.toContain("something_weird");
  });
});

describe("performBackup", () => {
  const base = {
    series: "authenticator" as BackupKind,
    deviceId: "dev-me",
    deviceLabel: "MY-PC",
    seal: async () => '{"sealed":true}',
  };

  it("uploads the first backup", async () => {
    const transport = new FakeTransport();
    const outcome = await performBackup({ ...base, transport, lastSyncedRemoteId: null });
    expect(outcome.kind).toBe("uploaded");
    expect(transport.files).toHaveLength(1);
    expect(transport.files[0].content).toBe('{"sealed":true}');
    expect(transport.files[0].deviceId).toBe("dev-me");
    expect(transport.files[0].name).toMatch(/^coretools-authenticator-/);
  });

  it("keeps the series independent: conflicts, naming and retention", async () => {
    const transport = new FakeTransport();
    // Another device's credential backup must not block an authenticator one…
    transport.files.push({ ...remote("cred", 1, "dev-other", "credmanager"), content: "{}" });
    const auth = await performBackup({ ...base, transport, lastSyncedRemoteId: null });
    expect(auth.kind).toBe("uploaded");
    if (auth.kind !== "uploaded") throw new Error("expected upload");
    expect(auth.versions.map((v) => backupKindOf(v.name))).toEqual(["authenticator"]);

    // …but it does conflict with a credential backup from this device.
    const cred = await performBackup({
      ...base,
      series: "credmanager",
      transport,
      lastSyncedRemoteId: null,
    });
    expect(cred).toMatchObject({ kind: "conflict", remote: { id: "cred" } });

    // Pruning one series never deletes the other's versions.
    for (let i = 0; i < MAX_VERSIONS + 2; i++) {
      transport.files.push({ ...remote(`a${i}`, 10 + i, "dev-me"), content: "{}" });
    }
    const latest = sortNewestFirst(ofKind(await transport.list(), "authenticator"))[0];
    await performBackup({ ...base, transport, lastSyncedRemoteId: latest.id });
    const left = await transport.list();
    expect(ofKind(left, "authenticator")).toHaveLength(MAX_VERSIONS);
    expect(ofKind(left, "credmanager").map((f) => f.id)).toEqual(["cred"]);
  });

  it("stops on a conflict without sealing or uploading", async () => {
    const transport = new FakeTransport();
    transport.files.push({ ...remote("theirs", 1, "dev-other"), content: "{}" });
    let sealed = false;
    const outcome = await performBackup({
      ...base,
      transport,
      lastSyncedRemoteId: null,
      seal: async () => {
        sealed = true;
        return "{}";
      },
    });
    expect(outcome).toMatchObject({ kind: "conflict", remote: { id: "theirs" } });
    expect(sealed).toBe(false);
    expect(transport.files).toHaveLength(1);
  });

  it("overrides a conflict when forced, keeping the other version for rollback", async () => {
    const transport = new FakeTransport();
    transport.files.push({ ...remote("theirs", 1, "dev-other"), content: "{}" });
    const outcome = await performBackup({ ...base, transport, lastSyncedRemoteId: null, force: true });
    expect(outcome.kind).toBe("uploaded");
    expect(transport.files.map((f) => f.id)).toContain("theirs");
  });

  it("discards an upload whose checksum doesn't verify, deleting nothing else", async () => {
    const transport = new FakeTransport();
    transport.files.push({ ...remote("old", 1, "dev-me"), content: "{}" });
    transport.corruptChecksum = true;
    await expect(
      performBackup({ ...base, transport, lastSyncedRemoteId: "old" }),
    ).rejects.toMatchObject({ token: "cloud_integrity" });
    expect(transport.files.map((f) => f.id)).toEqual(["old"]);
  });

  it("keeps the newest MAX_VERSIONS versions, including the new one", async () => {
    const transport = new FakeTransport();
    for (let i = 0; i < MAX_VERSIONS; i++) {
      transport.files.push({ ...remote(`v${i}`, i, "dev-me"), content: "{}" });
    }
    const outcome = await performBackup({ ...base, transport, lastSyncedRemoteId: `v${MAX_VERSIONS - 1}` });
    expect(outcome.kind === "uploaded" && outcome.pruned).toEqual(["v0"]);
    expect(transport.files).toHaveLength(MAX_VERSIONS);
    // The reported versions match what's actually left, newest first.
    if (outcome.kind !== "uploaded") throw new Error("expected upload");
    expect(outcome.versions).toHaveLength(MAX_VERSIONS);
    expect(outcome.versions[0].id).toBe(outcome.file.id);
    expect(outcome.versions.map((v) => v.id)).not.toContain("v0");
  });

  it("propagates transport failures with nothing deleted", async () => {
    const transport = new FakeTransport();
    transport.files.push({ ...remote("old", 1, "dev-me"), content: "{}" });
    transport.failUpload = "cloud_network";
    await expect(performBackup({ ...base, transport, lastSyncedRemoteId: "old" })).rejects.toBe(
      "cloud_network",
    );
    expect(transport.removed).toEqual([]);
  });
});
