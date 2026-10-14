import { describe, it, expect, beforeAll } from "vitest";
import {
  CLOUD_BACKUP_FORMAT,
  CLOUD_BACKUP_FORMAT_V1,
  CloudBackupError,
  deriveBackupKey,
  openCloudBackup,
  parseCloudBackup,
  restoreParts,
  sealCloudBackup,
  type CloudBackupFile,
} from "./cloud-backup";
import type { ExportableEntry } from "./backup";
import { bytesToBase64 } from "./legacy-crypto";
import {
  decryptString,
  deriveVaultKey,
  encryptString,
  importVaultKey,
  randomBytes,
  sha256Hex,
  VERIFIER_PLAINTEXT,
  type EncryptedBlob,
} from "./vault-crypto";
import { generateDataKey, wrapDataKey } from "./vault-keys";

// The floor accepted by parseCloudBackup; keeps PBKDF2 fast in tests.
const ITERATIONS = 100_000;
const PASSWORD = "correct horse battery";

const ENTRIES: ExportableEntry[] = [
  {
    type: "totp",
    issuer: "GitHub",
    account: "octo@example.com",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    counter: 0,
    index: 1,
    pinned: true,
  },
  {
    type: "hotp",
    issuer: "Bank",
    account: "me",
    secret: "GEZDGNBVGY3TQOJQ",
    algorithm: "SHA256",
    digits: 8,
    period: 30,
    counter: 42,
    index: 0,
    pinned: false,
  },
];

const SETTINGS = { autoLockMinutes: 10, clipboardClear: true, groupCodes: false };
const DEVICE = { id: "dev-1234abcd", label: "DESKTOP-TEST" };

let key: CryptoKey;
let salt: string;
let verifier: EncryptedBlob;

beforeAll(async () => {
  salt = bytesToBase64(randomBytes(16));
  key = await deriveVaultKey(PASSWORD, salt, ITERATIONS);
  verifier = await encryptString(key, VERIFIER_PLAINTEXT);
});

function seal(entries = ENTRIES) {
  return sealCloudBackup({
    key,
    keyHeader: { kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS }, salt },
    verifier,
    device: DEVICE,
    contents: "authenticator",
    entries,
    settings: { ...SETTINGS },
    createdAt: new Date("2026-10-11T10:30:00.000Z"),
  });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(CloudBackupError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("cloud backup envelope", () => {
  it("round-trips entries (order, pins, counters) and settings", async () => {
    const file = parseCloudBackup(await seal());
    const payload = await openCloudBackup(file, key);

    expect(payload.entryCount).toBe(2);
    // Sorted by index, re-indexed densely.
    expect(payload.entries.map((e) => e.issuer)).toEqual(["Bank", "GitHub"]);
    expect(payload.entries.map((e) => e.index)).toEqual([0, 1]);
    expect(payload.entries[0]).toMatchObject({
      type: "hotp",
      secret: "GEZDGNBVGY3TQOJQ",
      algorithm: "SHA256",
      digits: 8,
      counter: 42,
      pinned: false,
    });
    expect(payload.entries[1]).toMatchObject({ pinned: true, account: "octo@example.com" });
    expect(payload.settings).toEqual(SETTINGS);
  });

  it("keeps everything but the header encrypted", async () => {
    const text = await seal();
    for (const leaked of ["GitHub", "octo@example.com", "JBSWY3DPEHPK3PXP", "Bank"]) {
      expect(text).not.toContain(leaked);
    }
    const file = JSON.parse(text) as CloudBackupFile;
    // No wrapped key in the header → the legacy v1 layout, readable by 1.1.
    expect(file.format).toBe(CLOUD_BACKUP_FORMAT_V1);
    expect(file.device).toEqual(DEVICE);
    expect(file.kdf).toEqual({ name: "PBKDF2-SHA256", salt, iterations: ITERATIONS });
  });

  it("restores on a new device from the password alone", async () => {
    const file = parseCloudBackup(await seal());
    const derived = await deriveBackupKey(file, PASSWORD);
    const payload = await openCloudBackup(file, derived);
    expect(payload.entries).toHaveLength(2);
  });

  it("reports a wrong password distinctly from corruption", async () => {
    const file = parseCloudBackup(await seal());
    const wrong = await deriveBackupKey(file, "not the password");
    await expectCode(openCloudBackup(file, wrong), "wrong_password");
  });

  it("detects a tampered header via the GCM additional data", async () => {
    const file = JSON.parse(await seal()) as CloudBackupFile;
    file.device.label = "ATTACKER-PC";
    await expectCode(openCloudBackup(parseCloudBackup(JSON.stringify(file)), key), "corrupt");

    const file2 = JSON.parse(await seal()) as CloudBackupFile;
    file2.createdAt = "2030-01-01T00:00:00.000Z";
    await expectCode(openCloudBackup(parseCloudBackup(JSON.stringify(file2)), key), "corrupt");
  });

  it("detects damaged ciphertext", async () => {
    const file = JSON.parse(await seal()) as CloudBackupFile;
    const ct = file.payload.ct;
    const flipped = ct[10] === "A" ? "B" : "A";
    file.payload.ct = ct.slice(0, 10) + flipped + ct.slice(11);
    await expectCode(openCloudBackup(parseCloudBackup(JSON.stringify(file)), key), "corrupt");
  });

  it("rejects a payload whose checksum doesn't match its entries", async () => {
    // Re-seal a hand-built payload with a wrong digest under the real key,
    // simulating a writer bug rather than an attacker.
    const file = parseCloudBackup(await seal());
    const { payload: _payload, ...header } = file;
    const bogus = {
      version: 1,
      entryCount: 1,
      digest: "0".repeat(64),
      entries: [ENTRIES[0]],
      settings: SETTINGS,
    };
    const aad = new TextEncoder().encode(
      JSON.stringify([
        header.format,
        header.createdAt,
        header.device.id,
        header.device.label,
        header.kdf.name,
        header.kdf.salt,
        header.kdf.iterations,
        header.verifier.iv,
        header.verifier.ct,
        header.cipher,
      ]),
    );
    const sealed = await encryptString(key, JSON.stringify(bogus), aad);
    await expectCode(openCloudBackup({ ...header, payload: sealed }, key), "corrupt");
  });

  it("validates structure before any decryption", () => {
    expect(() => parseCloudBackup("not json")).toThrow(CloudBackupError);
    expect(() => parseCloudBackup("{}")).toThrow(/damaged/);
    expect(() =>
      parseCloudBackup(JSON.stringify({ format: "coretools-authenticator-cloud-v9" })),
    ).toThrow(/newer version/);
  });

  it("refuses implausible KDF work factors from a downloaded header", async () => {
    for (const iterations of [1, 99_999, 50_000_000, 1.5]) {
      const file = JSON.parse(await seal()) as CloudBackupFile;
      file.kdf.iterations = iterations;
      expect(() => parseCloudBackup(JSON.stringify(file))).toThrow(/key-derivation/);
    }
  });

  it("handles an empty vault", async () => {
    const payload = await openCloudBackup(parseCloudBackup(await seal([])), key);
    expect(payload.entries).toEqual([]);
    expect(payload.entryCount).toBe(0);
    expect(payload.credentials).toEqual([]);
  });

  it("marks an authenticator file as having no opinion about credentials", async () => {
    const file = parseCloudBackup(await seal());
    const payload = await openCloudBackup(file, key);
    expect(payload.contents).toBe("authenticator");
    expect(payload.credentialsDigest).toBe("");
    // No credentials fields at all: v1.1.0 reads it as a pre-Credential
    // Manager backup and never clears credentials when restoring it.
    const json = JSON.parse(await decryptPayload(file));
    expect(json).not.toHaveProperty("credentials");
    expect(json).not.toHaveProperty("credentialsDigest");
  });
});

describe("cloud backup: Credential Manager records", () => {
  const CREDENTIALS = [
    {
      platform: "AWS Production",
      url: "https://console.aws.amazon.com/",
      username: "devops-admin",
      password: "s3cr3t-P@ss",
      notes: "MFA on the yubikey",
      category: "Cloud",
      owner: "Platform team",
      space: "Dev team",
      tags: ["prod"],
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_100_000,
      passwordUpdatedAt: 1_760_000_100_000,
      deletedAt: null,
    },
    {
      platform: "Old bank",
      url: "",
      username: "me",
      password: "hunter2",
      notes: "",
      category: "",
      owner: "",
      tags: [],
      space: "",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      passwordUpdatedAt: 1_700_000_000_000,
      deletedAt: 1_760_000_000_000, // in the trash
    },
  ];

  function sealWith(credentials: typeof CREDENTIALS) {
    return sealCloudBackup({
      key,
      keyHeader: { kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS }, salt },
      verifier,
      device: DEVICE,
      contents: "credmanager",
      credentials,
    });
  }

  it("round-trips credentials, including trashed ones", async () => {
    const payload = await openCloudBackup(parseCloudBackup(await sealWith(CREDENTIALS)), key);
    expect(payload.contents).toBe("credmanager");
    expect(payload.credentials).toEqual(CREDENTIALS);
    expect(payload.credentialsDigest).not.toBe("");
    // A Credential Manager file holds no accounts and no display settings.
    expect(payload.entries).toEqual([]);
    expect(payload.settings).toBeNull();
  });

  it("keeps an empty Credential Manager backup meaningful", async () => {
    // "No credentials" is a real state to roll back to, unlike a legacy
    // file that simply predates the Credential Manager.
    const payload = await openCloudBackup(parseCloudBackup(await sealWith([])), key);
    expect(payload.credentials).toEqual([]);
    expect(payload.credentialsDigest).not.toBe("");
    expect(restoreParts([payload]).credentials).toEqual([]);
  });

  it("never leaves passwords, notes or usernames in the clear", async () => {
    const text = await sealWith(CREDENTIALS);
    for (const leaked of ["s3cr3t-P@ss", "hunter2", "yubikey", "devops-admin", "AWS Production"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("rejects accounts smuggled into a Credential Manager file", async () => {
    const file = parseCloudBackup(await sealWith(CREDENTIALS));
    const json = JSON.parse(await decryptPayload(file));
    json.entries = [ENTRIES[0]];
    json.entryCount = 1;
    json.digest = await sha256Hex(JSON.stringify(json.entries));
    await expectCode(openCloudBackup(await resealPayload(file, json), key), "corrupt");
  });

  it("restores combined backups made before credentials existed", async () => {
    // v1.0.x layout: accounts + settings, no contents tag, no credentials.
    const file = parseCloudBackup(await seal());
    const json = JSON.parse(await decryptPayload(file));
    delete json.contents;
    const payload = await openCloudBackup(await resealPayload(file, json), key);
    expect(payload.contents).toBe("combined");
    expect(payload.credentials).toEqual([]);
    expect(payload.credentialsDigest).toBe("");
    expect(payload.entries).toHaveLength(2);
    expect(restoreParts([payload])).toMatchObject({ credentials: null, settings: SETTINGS });
  });

  it("restores combined backups that carry credentials (v1.1.0)", async () => {
    const file = parseCloudBackup(await seal());
    const json = JSON.parse(await decryptPayload(file));
    delete json.contents;
    json.credentials = CREDENTIALS;
    json.credentialsDigest = await sha256Hex(JSON.stringify(CREDENTIALS));
    const payload = await openCloudBackup(await resealPayload(file, json), key);
    expect(payload.contents).toBe("combined");
    expect(payload.entries).toHaveLength(2);
    expect(payload.credentials).toEqual(CREDENTIALS);
    const parts = restoreParts([payload]);
    expect(parts.entries).toHaveLength(2);
    expect(parts.credentials).toEqual(CREDENTIALS);
  });

  it("combines one file per series into what to restore", async () => {
    const auth = await openCloudBackup(parseCloudBackup(await seal()), key);
    const cred = await openCloudBackup(parseCloudBackup(await sealWith(CREDENTIALS)), key);

    expect(restoreParts([auth])).toMatchObject({ credentials: null, settings: SETTINGS });
    expect(restoreParts([cred])).toMatchObject({ entries: null, settings: null });
    const both = restoreParts([cred, auth]);
    expect(both.entries).toHaveLength(2);
    expect(both.credentials).toEqual(CREDENTIALS);

    // A Credential Manager file wins over credentials in a legacy file.
    const legacy = { ...auth, contents: "combined" as const, credentials: [], credentialsDigest: "x" };
    expect(restoreParts([legacy, cred]).credentials).toEqual(CREDENTIALS);
  });

  it("keeps a restore inside one module when asked", async () => {
    const auth = await openCloudBackup(parseCloudBackup(await seal()), key);
    const cred = await openCloudBackup(parseCloudBackup(await sealWith(CREDENTIALS)), key);
    const legacy = {
      ...auth,
      contents: "combined" as const,
      credentials: CREDENTIALS,
      credentialsDigest: "x",
    };

    // From the Authenticator: a legacy file's credentials are left alone.
    expect(restoreParts([legacy], "authenticator")).toMatchObject({ credentials: null });
    expect(restoreParts([legacy], "authenticator").entries).toHaveLength(2);
    // From the Credential Manager: accounts and settings are left alone.
    expect(restoreParts([auth, cred], "credmanager")).toMatchObject({
      entries: null,
      settings: null,
      credentials: CREDENTIALS,
    });
  });

  it("reads backups made before spaces existed as having no space", async () => {
    const file = parseCloudBackup(await sealWith(CREDENTIALS));
    const json = JSON.parse(await decryptPayload(file));
    for (const c of json.credentials) delete c.space;
    json.credentialsDigest = await sha256Hex(JSON.stringify(json.credentials));
    const payload = await openCloudBackup(await resealPayload(file, json), key);
    expect(payload.credentials.map((c) => c.space)).toEqual(["", ""]);
    expect(payload.credentials[0]).toMatchObject({ platform: "AWS Production", owner: "Platform team" });
  });

  it("tidies space names and rejects a malformed one", async () => {
    const tidy = await openCloudBackup(
      parseCloudBackup(await sealWith([{ ...CREDENTIALS[0], space: "  Dev   team " }])),
      key,
    );
    expect(tidy.credentials[0].space).toBe("Dev team");

    const file = parseCloudBackup(await sealWith(CREDENTIALS));
    const json = JSON.parse(await decryptPayload(file));
    json.credentials[0].space = 42;
    json.credentialsDigest = await sha256Hex(JSON.stringify(json.credentials));
    await expectCode(openCloudBackup(await resealPayload(file, json), key), "corrupt");
  });

  it("detects a credentials checksum mismatch", async () => {
    const file = parseCloudBackup(await sealWith(CREDENTIALS));
    const json = JSON.parse(await decryptPayload(file));
    json.credentials[0].password = "changed";
    await expectCode(openCloudBackup(await resealPayload(file, json), key), "corrupt");
  });

  it("rejects non-http(s) login URLs inside a backup", async () => {
    const bad = [{ ...CREDENTIALS[0], url: "javascript:alert(1)" }];
    await expectCode(
      openCloudBackup(parseCloudBackup(await sealWith(bad)), key),
      "corrupt",
    );
  });
});

describe("cloud backup format v2 (Argon2id + wrapped data key)", () => {
  // The lowest work factor parseKdf accepts, so the suite stays fast.
  const FAST_ARGON = { name: "Argon2id" as const, memoryKiB: 19 * 1024, iterations: 1, parallelism: 1 };
  let dataKey: CryptoKey;
  let wrapped: Awaited<ReturnType<typeof wrapDataKey>>;
  let v2Verifier: EncryptedBlob;

  beforeAll(async () => {
    const raw = generateDataKey();
    wrapped = await wrapDataKey(PASSWORD, raw, FAST_ARGON);
    dataKey = await importVaultKey(raw);
    v2Verifier = await encryptString(dataKey, VERIFIER_PLAINTEXT);
  });

  function sealV2(tombstones: { k: string; at: number }[] = []) {
    return sealCloudBackup({
      key: dataKey,
      keyHeader: { kdf: wrapped.kdf, salt: wrapped.salt, wrappedKey: wrapped.wrappedKey },
      verifier: v2Verifier,
      device: DEVICE,
      contents: "authenticator",
      entries: ENTRIES,
      settings: { ...SETTINGS },
      tombstones,
      writer: "1.2.0",
    });
  }

  it("writes v2 and restores on a new device from the password alone", async () => {
    const file = parseCloudBackup(await sealV2());
    expect(file.format).toBe(CLOUD_BACKUP_FORMAT);
    expect(file.kdf).toMatchObject({ name: "Argon2id", memoryKiB: 19 * 1024, iterations: 1 });
    const payload = await openCloudBackup(file, await deriveBackupKey(file, PASSWORD));
    expect(payload.entries.map((e) => e.issuer)).toEqual(["Bank", "GitHub"]);
    expect(payload.writer).toBe("1.2.0");
  });

  it("reports a wrong password at the key unwrap", async () => {
    const file = parseCloudBackup(await sealV2());
    await expectCode(deriveBackupKey(file, "not the password"), "wrong_password");
  });

  it("binds the KDF parameters and wrapped key into the header AAD", async () => {
    for (const mutate of [
      (f: CloudBackupFile) => ((f.kdf as { iterations: number }).iterations = 2),
      (f: CloudBackupFile) => (f.wrappedKey = { ...f.wrappedKey!, iv: f.verifier.iv }),
    ]) {
      const file = JSON.parse(await sealV2()) as CloudBackupFile;
      mutate(file);
      // Either the key no longer unwraps, or the payload tag fails: never a silent open.
      const parsed = parseCloudBackup(JSON.stringify(file));
      await expect(
        deriveBackupKey(parsed, PASSWORD).then((k) => openCloudBackup(parsed, k)),
      ).rejects.toBeInstanceOf(CloudBackupError);
    }
  });

  it("refuses out-of-bounds Argon2id parameters before deriving anything", async () => {
    for (const memoryKiB of [1024, 4 * 1024 * 1024]) {
      const file = JSON.parse(await sealV2()) as CloudBackupFile;
      (file.kdf as { memoryKiB: number }).memoryKiB = memoryKiB;
      expect(() => parseCloudBackup(JSON.stringify(file))).toThrow(/key-derivation/);
    }
    const missing = JSON.parse(await sealV2()) as CloudBackupFile;
    delete missing.wrappedKey;
    expect(() => parseCloudBackup(JSON.stringify(missing))).toThrow(/wrapped key/);
  });

  it("carries tombstones and rejects malformed ones", async () => {
    const k = "a".repeat(64);
    const file = parseCloudBackup(await sealV2([{ k, at: 1_760_000_000_000 }]));
    const payload = await openCloudBackup(file, await deriveBackupKey(file, PASSWORD));
    expect(payload.tombstones).toEqual([{ k, at: 1_760_000_000_000 }]);
    expect(restoreParts([payload]).entryTombstones).toEqual(payload.tombstones);

    const json = JSON.parse(await decryptString(dataKey, file.payload, aadOfV2(file)));
    json.tombstones = [{ k: "not-a-hash", at: 1 }];
    const bad = { ...file, payload: await encryptString(dataKey, JSON.stringify(json), aadOfV2(file)) };
    await expectCode(openCloudBackup(bad, dataKey), "corrupt");
  });

  it("still opens v1 files with the same data key after a vault upgrade", async () => {
    // An upgraded vault keeps its data key, so its old v1 backups open with it.
    const file = parseCloudBackup(await seal());
    expect(file.format).toBe(CLOUD_BACKUP_FORMAT_V1);
    const payload = await openCloudBackup(file, await deriveBackupKey(file, PASSWORD));
    expect(payload.entries).toHaveLength(2);
  });

  function aadOfV2(file: CloudBackupFile): Uint8Array {
    const kdf = file.kdf as { name: string; salt: string; memoryKiB: number; iterations: number; parallelism: number };
    return new TextEncoder().encode(
      JSON.stringify([
        file.format,
        file.createdAt,
        file.device.id,
        file.device.label,
        kdf.name,
        kdf.salt,
        kdf.memoryKiB,
        kdf.iterations,
        kdf.parallelism,
        file.wrappedKey?.iv ?? "",
        file.wrappedKey?.ct ?? "",
        file.verifier.iv,
        file.verifier.ct,
        file.cipher,
      ]),
    );
  }
});

// Helpers that re-seal a modified payload under the real key + header AAD,
// to simulate writer bugs / old formats rather than attackers.
function aadOf(file: CloudBackupFile): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      file.format,
      file.createdAt,
      file.device.id,
      file.device.label,
      file.kdf.name,
      file.kdf.salt,
      file.kdf.iterations,
      file.verifier.iv,
      file.verifier.ct,
      file.cipher,
    ]),
  );
}

async function decryptPayload(file: CloudBackupFile): Promise<string> {
  return decryptString(key, file.payload, aadOf(file));
}

async function resealPayload(file: CloudBackupFile, json: unknown): Promise<CloudBackupFile> {
  return { ...file, payload: await encryptString(key, JSON.stringify(json), aadOf(file)) };
}
