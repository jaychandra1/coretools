import { describe, it, expect, beforeAll } from "vitest";
import {
  CLOUD_BACKUP_FORMAT,
  CloudBackupError,
  deriveBackupKey,
  openCloudBackup,
  parseCloudBackup,
  sealCloudBackup,
  type CloudBackupFile,
} from "./cloud-backup";
import type { ExportableEntry } from "./backup";
import { bytesToBase64 } from "./legacy-crypto";
import {
  decryptString,
  deriveVaultKey,
  encryptString,
  randomBytes,
  VERIFIER_PLAINTEXT,
  type EncryptedBlob,
} from "./vault-crypto";

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
    salt,
    iterations: ITERATIONS,
    verifier,
    device: DEVICE,
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
    expect(file.format).toBe(CLOUD_BACKUP_FORMAT);
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
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      passwordUpdatedAt: 1_700_000_000_000,
      deletedAt: 1_760_000_000_000, // in the trash
    },
  ];

  function sealWith(credentials: typeof CREDENTIALS) {
    return sealCloudBackup({
      key,
      salt,
      iterations: ITERATIONS,
      verifier,
      device: DEVICE,
      entries: ENTRIES,
      settings: { ...SETTINGS },
      credentials,
    });
  }

  it("round-trips credentials, including trashed ones", async () => {
    const payload = await openCloudBackup(parseCloudBackup(await sealWith(CREDENTIALS)), key);
    expect(payload.credentials).toEqual(CREDENTIALS);
    expect(payload.entries).toHaveLength(2);
  });

  it("never leaves passwords, notes or usernames in the clear", async () => {
    const text = await sealWith(CREDENTIALS);
    for (const leaked of ["s3cr3t-P@ss", "hunter2", "yubikey", "devops-admin", "AWS Production"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("restores backups made before credentials existed", async () => {
    // Rebuild a payload without the credentials fields, sealed the old way.
    const file = parseCloudBackup(await seal());
    const json = JSON.parse(await decryptPayload(file));
    delete json.credentials;
    delete json.credentialsDigest;
    const legacy = await resealPayload(file, json);
    const payload = await openCloudBackup(legacy, key);
    expect(payload.credentials).toEqual([]);
    expect(payload.entries).toHaveLength(2);
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
