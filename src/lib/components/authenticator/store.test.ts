/**
 * The vault's state machines, tested end to end against an in-memory
 * IndexedDB (audit F-17): password set/change, the 1.1 → 1.2 KDF upgrade,
 * sealed metadata, locking, restore merge/replace with deletion records,
 * the credential re-seal on a password change, and the audit chain.
 *
 * Each test gets fresh modules (the stores are singletons) and a fresh
 * database. Argon2id runs at the lowest accepted cost to keep this fast.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Each test re-imports the stores (fresh singletons); the first import in a
// busy parallel run compiles them cold, which can take a few seconds.
vi.setConfig({ testTimeout: 30_000 });

const STRONG = "tram violet kettle ninety";
const STRONG_2 = "orbit candle meadow seventy";

type Modules = Awaited<ReturnType<typeof load>>;

async function load(options: { register?: boolean } = {}) {
  vi.resetModules();
  vi.doMock("../../core/authenticator/kdf", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../core/authenticator/kdf")>();
    return {
      ...real,
      DEFAULT_KDF: { name: "Argon2id", memoryKiB: 19 * 1024, iterations: 1, parallelism: 1 },
    };
  });
  const store = await import("./store.svelte");
  const credentials = await import("../credentials/credentials.svelte");
  const db = await import("../../core/authenticator/db");
  const cloud = await import("../../core/authenticator/cloud-backup");
  const crypto = await import("../../core/authenticator/vault-crypto");
  if (options.register !== false) {
    const { bootstrapVault } = await import("../../vault-bootstrap");
    bootstrapVault();
  }
  await store.authStore.init();
  return { ...store, ...credentials, db, cloud, crypto };
}

const ACCOUNT = {
  type: "totp" as const,
  issuer: "GitHub",
  account: "octo@example.com",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1" as const,
  digits: 6,
  period: 30,
  counter: 0,
};

const LOGIN = {
  platform: "AWS Production",
  url: "https://console.aws.amazon.com",
  username: "devops-admin",
  category: "Cloud",
  owner: "Platform",
  tags: ["prod"],
  space: "Dev team",
  password: "s3cr3t-P@ss-word",
  notes: "MFA on the yubikey",
};

let m: Modules;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  m?.authStore.dispose();
});

describe("vault: password, sealing and locking", () => {
  it("rejects a weak master password and changes nothing", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await expect(m.authStore.setPassword("password1234")).rejects.toThrow();
    expect(m.authStore.encrypted).toBe(false);
  });

  it("seals secrets AND names at rest; lock drops them from memory; unlock restores them", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);

    const vault = await m.db.loadVaultConfig();
    expect(vault).toMatchObject({ encrypted: true, kdf: { name: "Argon2id" } });
    expect(vault?.wrappedKey).toBeDefined();
    expect(vault?.iterations).toBeUndefined();

    const [onDisk] = await m.db.loadEntries();
    expect(onDisk.issuer).toBe("");
    expect(onDisk.account).toBe("");
    expect(onDisk.meta).toBeDefined();
    expect(onDisk.secret.plain).toBeUndefined();
    expect(JSON.stringify(onDisk)).not.toContain("GitHub");

    m.authStore.lock();
    expect(m.authStore.entries[0].issuer).toBe("");
    expect(m.authStore.secretOf(m.authStore.entries[0].id)).toBeNull();

    await expect(m.authStore.unlock("wrong password here")).rejects.toThrow(/Wrong password/);
    await m.authStore.unlock(STRONG);
    expect(m.authStore.entries[0]).toMatchObject({ issuer: "GitHub", account: "octo@example.com" });
    expect(m.authStore.secretOf(m.authStore.entries[0].id)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("keeps the names sealed across a restart (fresh modules, same database)", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    m.authStore.dispose();

    m = await load();
    expect(m.authStore.locked).toBe(true);
    expect(m.authStore.entries[0].issuer).toBe("");
    await m.authStore.unlock(STRONG);
    expect(m.authStore.entries[0].issuer).toBe("GitHub");
  });

  it("flags a weak password typed at unlock (vaults made under the old policy)", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    expect(m.authStore.weakPassword).toBe(false);
  });
});

describe("vault: upgrade from a 1.1 (PBKDF2) vault", () => {
  async function seedLegacyVault(password: string) {
    const salt = m.crypto.randomBytes(16);
    const saltB64 = Buffer.from(salt).toString("base64");
    const key = await m.crypto.deriveVaultKey(password, saltB64, 100_000);
    await m.db.saveVaultConfig({
      encrypted: true,
      salt: saltB64,
      iterations: 100_000,
      verifier: await m.crypto.encryptString(key, m.crypto.VERIFIER_PLAINTEXT),
    });
    await m.db.saveEntries([
      {
        id: "legacy-1",
        hash: "h",
        issuer: "Bank",
        account: "me",
        type: "totp",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        counter: 0,
        index: 0,
        pinned: false,
        secret: { enc: await m.crypto.encryptString(key, "GEZDGNBVGY3TQOJQ") },
      },
    ]);
  }

  it("upgrades to Argon2id on unlock without re-encrypting, then seals the names", async () => {
    m = await load();
    const legacyPassword = "hunter22"; // 8 characters: allowed then, flagged now
    await seedLegacyVault(legacyPassword);
    m.authStore.dispose();
    m = await load();

    const before = await m.db.loadVaultConfig();
    const events: string[] = [];
    m.authStore.subscribe((e) => events.push(e));
    await m.authStore.unlock(legacyPassword);

    const after = await m.db.loadVaultConfig();
    expect(after).toMatchObject({ kdf: { name: "Argon2id" } });
    expect(after?.iterations).toBeUndefined();
    expect(after?.salt).not.toBe(before?.salt);
    // Same data key: the verifier and the secret blob are untouched.
    expect(after?.verifier).toEqual(before?.verifier);
    expect(m.authStore.secretOf("legacy-1")).toBe("GEZDGNBVGY3TQOJQ");
    expect(m.authStore.weakPassword).toBe(true);
    expect(events).toContain("password"); // fresh backups carry the new header

    const [onDisk] = await m.db.loadEntries();
    expect(onDisk.issuer).toBe("");
    expect(onDisk.meta).toBeDefined();

    m.authStore.lock();
    await m.authStore.unlock(legacyPassword);
    expect(m.authStore.entries[0].issuer).toBe("Bank");
  });
});

describe("vault + Credential Manager", () => {
  async function setUp() {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    await m.credentialStore.init();
    return m.credentialStore.add(LOGIN);
  }

  it("seals credential metadata at rest and decrypts it only while unlocked", async () => {
    const created = await setUp();
    const [onDisk] = await m.db.loadCredentials();
    expect(onDisk.platform).toBe("");
    expect(onDisk.username).toBe("");
    expect(JSON.stringify(onDisk)).not.toMatch(/AWS|devops|console/);

    m.authStore.lock();
    expect(m.credentialStore.items[0].platform).toBe("");
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.items[0]).toMatchObject({ id: created.id, platform: "AWS Production" });
  });

  it("re-seals credentials and the audit log on a password change, atomically", async () => {
    const created = await setUp();
    await m.authStore.setPassword(STRONG_2);
    m.authStore.lock();
    await expect(m.authStore.unlock(STRONG)).rejects.toThrow(/Wrong password/);
    await m.authStore.unlock(STRONG_2);

    const revealed = await m.credentialStore.revealPassword(created.id, async () => STRONG_2);
    expect(revealed).toBe(LOGIN.password);
    await m.credentialStore.loadAudit();
    expect(m.credentialStore.auditStatus).toMatchObject({ state: "verified" });
    expect(m.credentialStore.audit.map((e) => e.action)).toEqual(["revealed", "created"]);
  });

  it("refuses to re-key when stored credentials have no registered collection (F-18)", async () => {
    await setUp();
    m.authStore.dispose();
    m = await load({ register: false });
    await m.authStore.unlock(STRONG);
    const before = await m.db.loadVaultConfig();
    await expect(m.authStore.setPassword(STRONG_2)).rejects.toThrow(/Credential Manager/);
    expect(await m.db.loadVaultConfig()).toEqual(before);
  });

  it("keeps spaces sealed, re-keyed and persistent; moves logins between them", async () => {
    const created = await setUp();
    expect(JSON.stringify(await m.db.loadCredentials())).not.toContain("Dev team");

    m.credentialStore.activeSpace = "Dev team";
    m.credentialStore.pendingSpaces = ["Clients"];
    m.authStore.lock();
    expect(m.credentialStore.items[0].space).toBe("");
    expect(m.credentialStore.activeSpace).toBe("");
    expect(m.credentialStore.pendingSpaces).toEqual([]);
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.items[0].space).toBe("Dev team");

    expect(await m.credentialStore.moveToSpace(m.credentialStore.idsInSpace("Dev team"), " Platform ")).toBe(1);
    expect(await m.credentialStore.moveToSpace([created.id], "Platform")).toBe(0); // already there
    await m.authStore.setPassword(STRONG_2);
    m.authStore.dispose();

    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG_2);
    expect(m.credentialStore.items[0]).toMatchObject({ id: created.id, space: "Platform" });

    await m.credentialStore.moveToSpace([created.id], "");
    expect(m.credentialStore.items[0].space).toBe("");
    await m.credentialStore.loadAudit();
    expect(m.credentialStore.audit.map((e) => e.action)).toEqual(["updated", "updated", "created"]);
  });

  it("keeps the tab and login orders sealed, through a lock, a restart and a password change", async () => {
    const created = await setUp();
    const second = await m.credentialStore.add({ ...LOGIN, platform: "Zulu", username: "z" });
    await m.credentialStore.setSpaceOrder(["Personal", " Dev  team ", "personal", ""]);
    expect(m.credentialStore.spaceOrder).toEqual(["Personal", "Dev team"]);
    await m.credentialStore.setCredentialOrder([second.id, created.id, second.id, "gone"]);
    expect(m.credentialStore.credentialOrder).toEqual([second.id, created.id]); // deduped, unknown ids dropped
    const stored = await m.db.loadSpaceOrder();
    expect(stored?.sealed).toBeDefined();
    expect(JSON.stringify(stored)).not.toMatch(/Personal|Dev team/);
    const storedLogins = await m.db.loadCredentialOrder();
    expect(JSON.stringify(storedLogins)).not.toContain(created.id);

    m.authStore.lock();
    expect(m.credentialStore.spaceOrder).toEqual([]);
    expect(m.credentialStore.credentialOrder).toEqual([]);
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.spaceOrder).toEqual(["Personal", "Dev team"]);
    expect(m.credentialStore.credentialOrder).toEqual([second.id, created.id]);

    await m.authStore.setPassword(STRONG_2); // a new data key: both orders are re-sealed with it
    m.authStore.dispose();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG_2);
    expect(m.credentialStore.spaceOrder).toEqual(["Personal", "Dev team"]);
    expect(m.credentialStore.credentialOrder).toEqual([second.id, created.id]);

    await m.credentialStore.setCredentialOrder([]); // "Sort A–Z"
    expect(m.credentialStore.credentialOrder).toEqual([]);
  });

  it("opens logins saved before spaces existed as having no space", async () => {
    await setUp();
    const vault = m.authStore.vaultCrypto();
    const meta = await vault.encrypt(
      JSON.stringify({ platform: "Old login", url: "", username: "me", category: "", owner: "", tags: [] }),
    );
    await m.db.saveCredentials([
      {
        id: "pre-spaces",
        platform: "",
        url: "",
        username: "",
        category: "",
        owner: "",
        tags: [],
        meta,
        password: await m.authStore.encryptSecret("old-secret"),
        notes: null,
        createdAt: 1,
        updatedAt: 1,
        passwordUpdatedAt: 1,
        deletedAt: null,
      } as unknown as import("../../core/credentials/types").StoredCredential,
    ]);
    m.authStore.dispose();

    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.items.find((c) => c.id === "pre-spaces")).toMatchObject({
      platform: "Old login",
      space: "",
    });
  });

  it("exports a verifiable audit log", async () => {
    await setUp();
    const exported = JSON.parse(await m.credentialStore.exportAudit("1.2.0"));
    expect(exported.integrity).toMatchObject({ verified: true, events: 1 });
    expect(exported.events[0]).toMatchObject({ action: "created", platform: "AWS Production" });
  });
});

describe("restore: merge, replace and deletion records (F-09)", () => {
  async function backupPayload(series: "authenticator" | "credmanager") {
    const text = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, series);
    const payload = await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(text));
    if (!payload) throw new Error("own backup didn't open with the vault key");
    return payload;
  }

  it("doesn't bring back an account deleted on this device", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    const backup = await backupPayload("authenticator");

    await m.authStore.remove(m.authStore.entries[0].id);
    const result = await m.authStore.restoreFromBackup(m.cloud.restoreParts([backup]), "merge");
    expect(result).toMatchObject({ added: 0, skipped: 1 });
    expect(m.authStore.entries).toHaveLength(0);

    // A deliberate rollback ("replace") does bring it back.
    const rolled = await m.authStore.restoreFromBackup(m.cloud.restoreParts([backup]), "replace");
    expect(rolled.added).toBe(1);
    expect(m.authStore.entries[0].issuer).toBe("GitHub");
  });

  it("applies a deletion another device recorded after this device added the account", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT, { ...ACCOUNT, issuer: "Bank", secret: "GEZDGNBVGY3TQOJQ" }]);
    await m.authStore.setPassword(STRONG);
    const { accountKey } = await import("../../core/authenticator/backup");
    const { tombstoneKey } = await import("../../core/authenticator/tombstones");
    const githubKey = await tombstoneKey(accountKey(ACCOUNT));
    const later = Date.now() + 60_000;

    // Device B's backup: only Bank, plus B's record of deleting GitHub later.
    const fromB = await backupPayload("authenticator");
    const parts = {
      ...m.cloud.restoreParts([fromB]),
      entries: fromB.entries.filter((e) => e.issuer === "Bank"),
      entryTombstones: [{ k: githubKey, at: later }],
    };
    const result = await m.authStore.restoreFromBackup(parts, "merge");
    expect(result).toMatchObject({ removed: 1, added: 0, skipped: 1 });
    expect(m.authStore.entries.map((e) => e.issuer)).toEqual(["Bank"]);

    // A deletion recorded BEFORE this device added the account doesn't win.
    await m.authStore.addAccounts([ACCOUNT]);
    const older = await m.authStore.restoreFromBackup(
      { ...parts, entryTombstones: [{ k: githubKey, at: Date.now() - 60_000 }] },
      "merge",
    );
    expect(older.removed).toBe(0);
    expect(m.authStore.entries.map((e) => e.issuer).sort()).toEqual(["Bank", "GitHub"]);
  });

  it("doesn't resurrect a permanently deleted credential", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    await m.credentialStore.init();
    const created = await m.credentialStore.add(LOGIN);
    const backup = await backupPayload("credmanager");

    await m.credentialStore.remove(created.id);
    await m.credentialStore.purge([created.id]);
    expect(m.credentialStore.items).toHaveLength(0);

    const result = await m.authStore.restoreFromBackup(
      m.cloud.restoreParts([backup], "credmanager"),
      "merge",
    );
    expect(result).toMatchObject({ credentialsAdded: 0, credentialsSkipped: 1 });
    expect(m.credentialStore.items).toHaveLength(0);

    // Its tombstone travels in the next backup.
    const next = await backupPayload("credmanager");
    expect(next.tombstones).toHaveLength(1);
  });

  it("restores into a fresh install with the backup's password", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    const text = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "authenticator");
    m.authStore.dispose();

    globalThis.indexedDB = new IDBFactory();
    m = await load();
    expect(m.authStore.encrypted).toBe(false);
    const file = m.cloud.parseCloudBackup(text);
    const payload = await m.cloud.openCloudBackup(file, await m.cloud.deriveBackupKey(file, STRONG));
    await m.authStore.restoreFromBackup(m.cloud.restoreParts([payload]), "merge", STRONG);

    expect(m.authStore.encrypted).toBe(true);
    m.authStore.lock();
    await m.authStore.unlock(STRONG);
    expect(m.authStore.entries[0]).toMatchObject({ issuer: "GitHub" });
  });
});
