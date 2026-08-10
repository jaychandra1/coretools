import { describe, it, expect } from "vitest";
import {
  accountKey,
  buildExtensionBackup,
  buildGcmBackup,
  buildUriList,
  decryptBackupEntries,
  isGcmBackup,
  parseExtensionBackup,
  parseGcmBackup,
  parseUriList,
  previewImport,
  type ExportableEntry,
} from "./backup";
import { encryptLegacySecret } from "./legacy-crypto";
import { parseOtpAuthUri } from "./otpauth";
import { DEFAULTS } from "./types";

const MODERN_BACKUP = JSON.stringify({
  a1b2c3: {
    account: "user@example.com",
    counter: 0,
    encrypted: false,
    hash: "a1b2c3",
    index: 1,
    issuer: "GitHub",
    secret: "JBSWY3DPEHPK3PXP",
    type: "totp",
    period: 30,
    digits: 6,
    algorithm: "SHA1",
    pinned: true,
  },
  d4e5f6: {
    account: "gamer",
    counter: 0,
    encrypted: false,
    hash: "d4e5f6",
    index: 0,
    issuer: "Steam",
    secret: "MZXW6YTBOI",
    type: "steam",
  },
});

describe("parseExtensionBackup", () => {
  it("parses the modern format and sorts by index", () => {
    const entries = parseExtensionBackup(MODERN_BACKUP);
    expect(entries).toHaveLength(2);
    expect(entries[0].issuer).toBe("Steam"); // index 0 first
    expect(entries[0].type).toBe("steam");
    expect(entries[0].digits).toBe(5); // steam default when absent
    expect(entries[1].pinned).toBe(true);
  });

  it("handles legacy numeric enums and missing fields", () => {
    const entries = parseExtensionBackup(
      JSON.stringify({
        x: { account: "a", secret: "JBSWY3DPEHPK3PXP", type: 1, counter: 0 },
        y: { account: "b", secret: "JBSWY3DPEHPK3PXP", type: 3, algorithm: 2 },
        z: { account: "c", secret: "JBSWY3DPEHPK3PXP", type: 4 },
      }),
    );
    expect(entries.map((e) => e.type)).toEqual(["totp", "blizzard", "steam"]);
    expect(entries[0].algorithm).toBe(DEFAULTS.algorithm);
    expect(entries[0].digits).toBe(6);
    expect(entries[0].period).toBe(30);
    expect(entries[1].algorithm).toBe("SHA256");
    expect(entries[1].digits).toBe(8); // blizzard default
  });

  it("maps 'battle' to blizzard", () => {
    const [entry] = parseExtensionBackup(
      JSON.stringify({
        x: { account: "a", secret: "JBSWY3DPEHPK3PXP", type: "battle" },
      }),
    );
    expect(entry.type).toBe("blizzard");
  });

  it("skips non-entry keys (e.g. encrypted-backup 'key' metadata)", () => {
    const entries = parseExtensionBackup(
      JSON.stringify({
        key: { enc: "xxx", hash: "yyy" },
        x: { account: "a", secret: "JBSWY3DPEHPK3PXP", type: "totp" },
      }),
    );
    expect(entries).toHaveLength(1);
  });

  it("rejects non-backups", () => {
    expect(() => parseExtensionBackup("not json")).toThrow(/JSON/);
    expect(() => parseExtensionBackup("[1,2]")).toThrow(/object/);
    expect(() => parseExtensionBackup('{"a": 1}')).toThrow(/No authenticator entries/);
  });
});

describe("encrypted backups", () => {
  it("decrypts entries with the backup password", async () => {
    const cipher = await encryptLegacySecret("JBSWY3DPEHPK3PXP", "backup-pw");
    const entries = parseExtensionBackup(
      JSON.stringify({
        x: {
          account: "a",
          issuer: "GitHub",
          secret: cipher,
          type: "totp",
          encrypted: true,
        },
      }),
    );
    expect(entries[0].encrypted).toBe(true);

    const decrypted = await decryptBackupEntries(entries, "backup-pw");
    expect(decrypted[0].secret).toBe("JBSWY3DPEHPK3PXP");
    expect(decrypted[0].encrypted).toBe(false);

    await expect(decryptBackupEntries(entries, "wrong")).rejects.toThrow();
  });
});

describe("parseUriList", () => {
  it("parses one URI per line, skipping blanks and comments", () => {
    const accounts = parseUriList(
      [
        "# my backup",
        "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        "",
        "otpauth://hotp/Acme:bob?secret=MZXW6YTBOI&counter=3",
      ].join("\n"),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[1].counter).toBe(3);
  });

  it("throws when nothing parses", () => {
    expect(() => parseUriList("hello world")).toThrow();
  });
});

describe("previewImport duplicate detection", () => {
  const existing = [
    { secret: "JBSWY3DPEHPK3PXP", issuer: "GitHub", account: "alice" },
  ];
  const incoming = (over: Partial<ReturnType<typeof parseOtpAuthUri>>) => ({
    type: "totp" as const,
    issuer: "GitHub",
    account: "alice",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1" as const,
    digits: 6,
    period: 30,
    counter: 0,
    ...over,
  });

  it("skips same secret+issuer+account, keeps everything else", () => {
    const preview = previewImport(existing, [
      incoming({}), // exact duplicate
      incoming({ account: "bob" }), // different account -> fresh
      incoming({ secret: "MZXW6YTBOI" }), // different secret -> fresh
    ]);
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.fresh).toHaveLength(2);
  });

  it("is case/whitespace-insensitive and dedupes within the batch", () => {
    const preview = previewImport(existing, [
      incoming({ issuer: "github ", secret: "jbsw y3dp ehpk 3pxp" }),
      incoming({ account: "bob" }),
      incoming({ account: "bob" }), // duplicate within the batch
    ]);
    expect(preview.duplicates).toHaveLength(2);
    expect(preview.fresh).toHaveLength(1);
  });

  it("flags invalid secrets", () => {
    const preview = previewImport([], [incoming({ secret: "!!!" })]);
    expect(preview.invalid).toHaveLength(1);
    expect(preview.fresh).toHaveLength(0);
  });

  it("accountKey normalizes consistently", () => {
    expect(
      accountKey({ secret: "jbsw y3dp ehpk 3pxp", issuer: " GitHub", account: "Alice" }),
    ).toBe(accountKey({ secret: "JBSWY3DPEHPK3PXP", issuer: "github", account: "alice " }));
  });
});

const EXPORT_ENTRIES: ExportableEntry[] = [
  {
    type: "totp",
    issuer: "GitHub",
    account: "alice",
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA256",
    digits: 7,
    period: 60,
    counter: 0,
    index: 1,
    pinned: false,
  },
  {
    type: "blizzard",
    issuer: "Battle.net",
    account: "bob",
    secret: "MZXW6YTBOI",
    algorithm: "SHA1",
    digits: 8,
    period: 30,
    counter: 0,
    index: 0,
    pinned: true,
  },
];

describe("backup round-trip", () => {
  it("unencrypted: export -> import preserves everything", async () => {
    const backup = await buildExtensionBackup(EXPORT_ENTRIES);
    const json = JSON.stringify(backup);

    // Extension-format invariants
    const parsedRaw = JSON.parse(json) as Record<string, { hash: string; index: number; type: string; encrypted: boolean }>;
    for (const [key, value] of Object.entries(parsedRaw)) {
      expect(key).toBe(value.hash);
      expect(key).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex of the secret
      expect(value.encrypted).toBe(false);
    }
    expect(Object.values(parsedRaw).some((v) => v.type === "battle")).toBe(true);

    const entries = parseExtensionBackup(json);
    expect(entries).toHaveLength(2);
    expect(entries[0].issuer).toBe("Battle.net"); // index order preserved
    expect(entries[0].type).toBe("blizzard");
    expect(entries[0].pinned).toBe(true);
    expect(entries[1].algorithm).toBe("SHA256");
    expect(entries[1].digits).toBe(7);
    expect(entries[1].period).toBe(60);
    expect(entries[1].secret).toBe("JBSWY3DPEHPK3PXP");
  });

  it("encrypted: export with password -> import + decrypt restores secrets", async () => {
    const backup = await buildExtensionBackup(EXPORT_ENTRIES, "s3cret");
    const entries = parseExtensionBackup(JSON.stringify(backup));
    expect(entries.every((e) => e.encrypted)).toBe(true);
    expect(entries.every((e) => e.secret !== "JBSWY3DPEHPK3PXP")).toBe(true);

    const decrypted = await decryptBackupEntries(entries, "s3cret");
    expect(decrypted.map((e) => e.secret).sort()).toEqual([
      "JBSWY3DPEHPK3PXP",
      "MZXW6YTBOI",
    ]);
  });

  it("GCM backup: export with password -> detect + import restores everything", async () => {
    const file = await buildGcmBackup(EXPORT_ENTRIES, "modern-pw");
    const json = JSON.stringify(file);

    expect(isGcmBackup(json)).toBe(true);
    expect(isGcmBackup(MODERN_BACKUP)).toBe(false);
    expect(json).not.toContain("JBSWY3DPEHPK3PXP"); // secrets are ciphertext

    const entries = await parseGcmBackup(json, "modern-pw");
    expect(entries).toHaveLength(2);
    expect(entries[0].issuer).toBe("Battle.net"); // index order preserved
    expect(entries[0].type).toBe("blizzard");
    expect(entries[1].secret).toBe("JBSWY3DPEHPK3PXP");
    expect(entries[1].algorithm).toBe("SHA256");

    await expect(parseGcmBackup(json, "wrong")).rejects.toThrow(/password/i);
  });

  it("URI list export parses back", () => {
    const text = buildUriList(EXPORT_ENTRIES);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    const accounts = parseUriList(text);
    expect(accounts[0].issuer).toBe("Battle.net");
    expect(accounts[1].secret).toBe("JBSWY3DPEHPK3PXP");
  });
});
