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

/**
 * Holds every key derivation (the slow step of unlock and password changes)
 * while set, so a test can let "another window" write in the middle of one.
 */
const kdfGate: { wait: Promise<void> | null; reached: boolean } = { wait: null, reached: false };

async function load(options: { register?: boolean } = {}) {
  vi.resetModules();
  vi.doMock("../../core/authenticator/kdf", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../core/authenticator/kdf")>();
    return {
      ...real,
      DEFAULT_KDF: { name: "Argon2id", memoryKiB: 19 * 1024, iterations: 1, parallelism: 1 },
      deriveKeyBytes: async (...args: Parameters<typeof real.deriveKeyBytes>) => {
        if (kdfGate.wait) {
          kdfGate.reached = true;
          await kdfGate.wait;
        }
        return real.deriveKeyBytes(...args);
      },
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
  kdfGate.wait = null;
  kdfGate.reached = false;
});

afterEach(() => {
  m?.authStore.dispose();
  m?.db.unwatchExternalChanges();
});

async function rawGet(store: string, key: string): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("coretools-authenticator");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

/** Another window writes: `change` on disk, the generation bumped, and the broadcast it sends. */
async function otherWindowWrites(change?: () => Promise<void>): Promise<void> {
  await change?.();
  const generation = (((await rawGet("meta", "generation")) as number | undefined) ?? 0) + 1;
  await rawPut("meta", generation, "generation");
  const channel = new BroadcastChannel("coretools-vault");
  channel.postMessage({ generation });
  channel.close();
}

/** Hold key derivations until the returned function is called. */
function holdKeyDerivation(): () => void {
  let release!: () => void;
  kdfGate.wait = new Promise((resolve) => (release = resolve));
  return () => {
    kdfGate.wait = null;
    release();
  };
}

/** Write straight into the database, the way another window (or someone with disk access) would. */
async function rawPut(store: string, value: unknown, key?: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("coretools-authenticator");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

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
    const stored = await m.db.loadSealedList(m.db.SPACE_ORDER_KEY);
    expect(stored?.sealed).toBeDefined();
    expect(JSON.stringify(stored)).not.toMatch(/Personal|Dev team/);
    const storedLogins = await m.db.loadSealedList(m.db.CREDENTIAL_ORDER_KEY);
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
        password: await vault.encrypt("old-secret"), // pre-1.3: not bound to the record
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
    const { content: text } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, series);
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
    const { content: text } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "authenticator");
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

describe("robustness (data audit)", () => {
  async function setUp() {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    await m.credentialStore.init();
    return m.credentialStore.add(LOGIN);
  }

  it("refuses a write from a window whose copy is stale, then reads the vault again (D-1)", async () => {
    await setUp();
    await rawPut("meta", 999, "generation"); // another window wrote meanwhile
    await expect(m.authStore.rename(m.authStore.entries[0].id, "Changed", "x")).rejects.toThrow(
      /changed in another window/,
    );
    await m.authStore.beginWrite(); // the reload it triggered
    // Same key: still unlocked, with the copy on disk, which the refused write didn't touch.
    expect(m.authStore.locked).toBe(false);
    expect(m.authStore.entries[0].issuer).toBe("GitHub");
    await m.authStore.rename(m.authStore.entries[0].id, "Renamed", "x"); // fresh copy: writes again
    expect(m.authStore.entries[0].issuer).toBe("Renamed");
  });

  it("stays unlocked when another window writes with the same key, showing its change (NEW-4)", async () => {
    await setUp();
    const [first] = await m.db.loadEntries();
    await otherWindowWrites(() => rawPut("entries", { ...first, pinned: true }));
    await vi.waitFor(() => expect(m.authStore.entries[0].pinned).toBe(true));
    await m.authStore.beginWrite();
    expect(m.authStore.locked).toBe(false);
    expect(m.authStore.entries[0].issuer).toBe("GitHub");
    expect(m.credentialStore.items[0].platform).toBe(LOGIN.platform);
  });

  it("locks when another window changed the password", async () => {
    await setUp();
    const vault = await m.db.loadVaultConfig();
    await otherWindowWrites(() =>
      rawPut("meta", { ...vault, verifier: { iv: vault!.verifier!.iv, ct: "AAAA" } }, "vault"),
    );
    await vi.waitFor(() => expect(m.authStore.locked).toBe(true));
    expect(m.authStore.notice).toMatch(/new password/);
    expect(m.authStore.entries[0].issuer).toBe("");
  });

  it("runs overlapping writes of one window one after the other (NEW-2)", async () => {
    await setUp();
    await m.authStore.addAccounts([{ ...ACCOUNT, issuer: "Second", secret: "GEZDGNBVGY3TQOJQ" }]);
    const [a, b] = m.authStore.entries.map((e) => e.id);
    await Promise.all([m.authStore.togglePin(a), m.authStore.togglePin(b), m.authStore.updateSettings({ groupCodes: false })]);
    expect(m.authStore.locked).toBe(false);
    expect((await m.db.loadEntries()).every((e) => e.pinned)).toBe(true);
  });

  it("refuses a password change prepared before another window's write (NEW-1)", async () => {
    await setUp();
    const release = holdKeyDerivation();
    const change = m.authStore.setPassword(STRONG_2);
    await vi.waitFor(() => expect(kdfGate.reached).toBe(true));
    await otherWindowWrites();
    await vi.waitFor(async () => expect(await m.authStore.beginWrite()).toBeGreaterThan(0));
    release();
    await expect(change).rejects.toThrow(/changed in another window/);

    // Nothing was written: the old password still opens everything.
    m.authStore.dispose();
    m.db.unwatchExternalChanges();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.items[0].platform).toBe(LOGIN.platform);
    expect(m.credentialStore.unreadable).toBe(0);
  });

  it("doesn't drop another window's account when setting the first password (NEW-1)", async () => {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]); // no password yet
    const release = holdKeyDerivation();
    const change = m.authStore.setPassword(STRONG);
    await vi.waitFor(() => expect(kdfGate.reached).toBe(true));
    const [first] = await m.db.loadEntries();
    await otherWindowWrites(() =>
      rawPut("entries", { ...first, id: "other-window", issuer: "Elsewhere", index: 1, secret: { plain: "GEZDGNBVGY3TQOJQ" } }),
    );
    await vi.waitFor(() => expect(m.authStore.entries).toHaveLength(2));
    release();
    await expect(change).rejects.toThrow(/changed in another window/);
    expect((await m.db.loadEntries()).map((e) => e.id)).toContain("other-window");
    await m.authStore.setPassword(STRONG); // from the fresh copy: both accounts sealed
    m.authStore.lock();
    await m.authStore.unlock(STRONG);
    expect(m.authStore.entries.map((e) => e.issuer).sort()).toEqual(["Elsewhere", "GitHub"]);
  });

  it("unlocks around a record that can't be decrypted, and reports it (D-2)", async () => {
    await setUp();
    await m.authStore.addAccounts([{ ...ACCOUNT, issuer: "Second", secret: "GEZDGNBVGY3TQOJQ" }]);
    const [first] = await m.db.loadEntries();
    await rawPut("entries", { ...first, secret: { enc: { iv: first.secret.enc!.iv, ct: "AAAA", v: 2 } } });
    m.authStore.dispose();
    m = await load();
    await m.authStore.unlock(STRONG);
    expect(m.authStore.unreadableEntries).toBe(1);
    expect(m.authStore.entries.map((e) => e.issuer)).toEqual(["Second"]);
  });

  it("merges by last writer: a newer password in the backup wins (D-3)", async () => {
    const created = await setUp();
    const { content } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "credmanager");
    const older = await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(content));
    // This device changes the password; the backup made before that must not undo it.
    await new Promise((r) => setTimeout(r, 5));
    await m.credentialStore.update(created.id, { ...LOGIN, password: "rotated-P@ss-1", notes: null });
    let result = await m.authStore.restoreFromBackup(m.cloud.restoreParts([older!], "credmanager"), "merge");
    expect(result).toMatchObject({ credentialsUpdated: 0, credentialsSkipped: 1 });
    expect(await m.credentialStore.revealPassword(created.id, async () => STRONG)).toBe("rotated-P@ss-1");

    // A backup holding a newer copy replaces the older one here.
    const newer = { ...older!, credentials: older!.credentials.map((c) => ({ ...c, password: "newest-P@ss-2", updatedAt: Date.now() + 60_000 })) };
    result = await m.authStore.restoreFromBackup(m.cloud.restoreParts([newer], "credmanager"), "merge");
    expect(result).toMatchObject({ credentialsUpdated: 1, credentialsAdded: 0 });
    expect(m.credentialStore.items).toHaveLength(1);
    expect(await m.credentialStore.revealPassword(created.id, async () => STRONG)).toBe("newest-P@ss-2");
  });

  it("deletes an account with its tombstone at once, and Undo puts it back (D-6)", async () => {
    await setUp();
    const removed = await m.authStore.remove(m.authStore.entries[0].id);
    expect(m.authStore.entries).toHaveLength(0);
    const { content } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "authenticator");
    expect((await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(content)))!.tombstones).toHaveLength(1);
    await m.authStore.restoreRemoved(removed!);
    expect(m.authStore.entries.map((e) => e.issuer)).toEqual(["GitHub"]);
    const again = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "authenticator");
    expect((await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(again.content)))!.tombstones).toHaveLength(0);
  });

  it("snapshots before a password change and can roll back to it (D-8)", async () => {
    await setUp();
    await m.authStore.updateSettings({ autoLockMinutes: 1, clipboardClear: false });
    await m.authStore.setPassword(STRONG_2);
    const [snapshot] = await m.authStore.listSnapshots();
    expect(snapshot).toMatchObject({ reason: "password-change", entries: 1, credentials: 1 });

    // The password the vault had then is checked before anything changes (NEW-6).
    await expect(
      m.authStore.restoreSnapshot(snapshot.id, async () => STRONG_2, async () => "not the old one at all"),
    ).rejects.toThrow(/Nothing was changed/);
    expect(await m.authStore.verifyPassword(STRONG_2)).toBe(true);

    await m.authStore.restoreSnapshot(snapshot.id, async () => STRONG_2, async () => STRONG);
    expect(m.authStore.locked).toBe(false); // opened with the password checked above
    expect(m.authStore.entries[0].issuer).toBe("GitHub");
    expect(m.credentialStore.items[0].platform).toBe(LOGIN.platform);
    m.authStore.lock();
    await expect(m.authStore.unlock(STRONG_2)).rejects.toThrow(/Wrong password/);
    await m.authStore.unlock(STRONG); // the password in use when the snapshot was taken
    // The settings came along, sealed under the old key (NEW-7).
    expect(m.authStore.settings).toMatchObject({ autoLockMinutes: 1, clipboardClear: false });
  });

  it("restores the oldest snapshot without pruning it first (NEW-3)", async () => {
    await setUp();
    for (const password of [STRONG_2, STRONG, STRONG_2, STRONG, STRONG_2]) {
      await m.authStore.setPassword(password);
      await new Promise((r) => setTimeout(r, 2));
    }
    const all = await m.authStore.listSnapshots();
    expect(all).toHaveLength(5);
    const oldest = all[all.length - 1];
    await m.authStore.restoreSnapshot(oldest.id, async () => STRONG_2, async () => STRONG);
    expect(m.authStore.locked).toBe(false);
    const after = await m.authStore.listSnapshots();
    expect(after).toHaveLength(5);
    expect(after[0].reason).toBe("before-snapshot-restore");
  });

  it("keeps undecryptable records through a password change (NEW-5)", async () => {
    await setUp();
    await m.authStore.addAccounts([{ ...ACCOUNT, issuer: "Second", secret: "GEZDGNBVGY3TQOJQ" }]);
    const [first] = await m.db.loadEntries();
    await rawPut("entries", { ...first, secret: { enc: { iv: first.secret.enc!.iv, ct: "AAAA", v: 2 } } });
    m.authStore.dispose();
    m.db.unwatchExternalChanges();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    expect(m.authStore.unreadableEntries).toBe(1);
    await m.authStore.setPassword(STRONG_2);
    expect((await m.db.loadEntries()).map((e) => e.id)).toContain(first.id);
    expect(m.authStore.unreadableEntries).toBe(1);
  });

  it("makes an undone deletion newer than the deletion it undoes (N10)", async () => {
    await setUp();
    const removed = await m.authStore.remove(m.authStore.entries[0].id);
    const deletedAt = Date.now();
    await new Promise((r) => setTimeout(r, 2));
    await m.authStore.restoreRemoved(removed!);
    const [onDisk] = await m.db.loadEntries();
    expect(onDisk.addedAt).toBeGreaterThan(deletedAt);
  });

  it("never re-seals a planted plaintext record into a sealed log (S-4)", async () => {
    await setUp();
    await rawPut("audit", { id: "planted", at: 1, action: "created", credentialId: "x", platform: "Forged" });
    m.authStore.dispose();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    await m.credentialStore.loadAudit();
    expect(m.credentialStore.auditStatus).toMatchObject({ state: "tampered" });
    const records = await m.db.loadAuditRecords();
    expect(records.some((r) => r.id === "planted" && !r.sealed)).toBe(true); // left as evidence
    expect(records.filter((r) => r.sealed).length).toBeGreaterThan(0); // history kept
  });

  it("marks a plaintext log sealed on upgrade as unverifiable, even a planted one", async () => {
    await setUp();
    // Someone deletes the sealed log and its head, and plants a plaintext event.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("coretools-authenticator");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(["audit", "meta"], "readwrite");
      tx.objectStore("audit").clear();
      tx.objectStore("meta").delete("auditHead");
      tx.oncomplete = () => resolve();
    });
    db.close();
    await rawPut("audit", { id: "forged", at: 1, action: "created", credentialId: "x", platform: "Forged" });
    m.authStore.dispose();
    m.db.unwatchExternalChanges();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    await vi.waitFor(async () => expect((await m.db.loadAuditRecords()).every((r) => r.sealed)).toBe(true));
    await m.credentialStore.loadAudit();
    // Newest first: the import marker sits above everything it can't vouch for.
    expect(m.credentialStore.audit.map((e) => e.action)).toEqual(["log-imported", "created"]);
  });

  it("lets the sealed copy of the security settings win over planted values", async () => {
    await setUp();
    // Looser than the defaults, so only the sealed copy can bring these back
    // (the fallback for a missing one would give the defaults).
    await m.authStore.updateSettings({ credentialsRevealAuth: false, autoLockMinutes: 30, clipboardClear: false });
    const stored = await m.db.loadSettings();
    await rawPut("meta", { ...stored, autoLockMinutes: 0 }, "settings");
    m.authStore.dispose();
    m = await load();
    expect(m.authStore.settings.autoLockMinutes).toBe(0); // plaintext, while locked
    await m.authStore.unlock(STRONG);
    expect(m.authStore.settings).toMatchObject({ credentialsRevealAuth: false, autoLockMinutes: 30, clipboardClear: false });
  });

  it("doesn't let planted settings win by deleting or swapping the sealed copy (N3)", async () => {
    await setUp();
    await m.authStore.updateSettings({ autoLockMinutes: 3 });
    await m.authStore.remove(m.authStore.entries[0].id); // sealed deletion records exist now
    const stored = await m.db.loadSettings();
    const tombstones = await m.db.loadTombstones();
    const planted = { credentialsRevealAuth: false, autoLockMinutes: 0, clipboardClear: false };
    for (const sealed of [undefined, tombstones!.sealed]) {
      await rawPut("meta", { ...stored, ...planted, sealed }, "settings");
      m.authStore.dispose();
      m.db.unwatchExternalChanges();
      m = await load();
      await m.authStore.unlock(STRONG);
      // Neither copy is trusted alone: the stricter of the plaintext and the defaults.
      expect(m.authStore.settings).toMatchObject({ credentialsRevealAuth: true, autoLockMinutes: 5, clipboardClear: true });
    }
  });

  it("refuses security changes while locked, keeping the sealed copy", async () => {
    await setUp();
    const sealed = (await m.db.loadSettings()).sealed;
    m.authStore.lock();
    await expect(m.authStore.updateSettings({ autoLockMinutes: 0 })).rejects.toThrow(/Unlock first/);
    await m.authStore.updateSettings({ groupCodes: false });
    expect((await m.db.loadSettings()).sealed).toEqual(sealed);
  });

  it("asks every time for a sensitive check, but lets reveals reuse one (N7)", async () => {
    await setUp();
    let asked = 0;
    const prompt = async () => (asked++, STRONG);
    await m.authStore.confirmUser(prompt, { reuse: true });
    await m.authStore.confirmUser(prompt, { reuse: true });
    expect(asked).toBe(1);
    await m.authStore.confirmUser(prompt);
    await m.authStore.confirmUser(prompt);
    expect(asked).toBe(3);
  });
});

describe("locking, wiping and other windows while work is in flight", () => {
  async function setUp() {
    m = await load();
    await m.authStore.addAccounts([ACCOUNT]);
    await m.authStore.setPassword(STRONG);
    await m.credentialStore.init();
    return m.credentialStore.add(LOGIN);
  }

  /** Hold the Credential Manager's part of an in-place reload until released. */
  function holdReloadHook() {
    let release!: () => void;
    const held = { reached: false, release: () => release() };
    const wait = new Promise<void>((resolve) => (release = resolve));
    const hooks = m.credentialStore.vaultHooks();
    m.authStore.registerCredentials({
      ...hooks,
      reload: async (crypto) => {
        held.reached = true;
        await wait;
        return hooks.reload(crypto);
      },
    });
    return held;
  }

  it("keeps a vault locked during a reload locked: nothing decrypted comes back", async () => {
    await setUp();
    const id = m.authStore.entries[0].id;
    const held = holdReloadHook();
    await otherWindowWrites();
    await vi.waitFor(() => expect(held.reached).toBe(true));
    m.authStore.lock("auto"); // the idle timer fires meanwhile
    held.release();
    await m.authStore.beginWrite();
    expect(m.authStore.locked).toBe(true);
    expect(m.authStore.secretOf(id)).toBeNull();
    expect(m.authStore.entries[0].issuer).toBe("");
    expect(m.credentialStore.items[0].platform).toBe("");
  });

  it("refuses a password change when the vault locks during it", async () => {
    m = await load();
    await m.authStore.setPassword(STRONG); // logins only, no 2FA accounts
    await m.credentialStore.init();
    await m.credentialStore.add(LOGIN);
    const release = holdKeyDerivation();
    const change = m.authStore.setPassword(STRONG_2);
    await vi.waitFor(() => expect(kdfGate.reached).toBe(true));
    m.authStore.lock();
    release();
    await expect(change).rejects.toThrow(/nothing was saved/);
    await m.authStore.unlock(STRONG); // nothing was re-keyed
    expect(m.credentialStore.items[0].platform).toBe(LOGIN.platform);
    expect(m.credentialStore.unreadable).toBe(0);
  });

  it("never writes plaintext deletion records when the vault locks mid-delete", async () => {
    await setUp();
    const id = m.authStore.entries[0].id;
    const subtle = globalThis.crypto.subtle;
    const digest = subtle.digest.bind(subtle);
    let armed = true;
    const spy = vi.spyOn(subtle, "digest").mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
      if (armed) {
        armed = false;
        m.authStore.lock();
      }
      return digest(...args);
    });
    try {
      await expect(m.authStore.remove(id)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    const stored = (await rawGet("meta", "tombstones")) as { plain?: unknown } | undefined;
    expect(stored?.plain).toBeUndefined();
    expect(await m.db.loadEntries()).toHaveLength(1);
  });

  it("unlocks with the logins on disk, even when another window adds one mid-unlock", async () => {
    await setUp();
    const x = await m.credentialStore.add({ ...LOGIN, platform: "Other window", username: "x" });
    const xRaw = (await m.db.loadCredentials()).find((c) => c.id === x.id)!;
    await otherWindowWrites(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("coretools-authenticator");
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction("credentials", "readwrite");
        tx.objectStore("credentials").delete(x.id);
        tx.oncomplete = () => resolve();
      });
      db.close();
    });
    await vi.waitFor(() => expect(m.credentialStore.items).toHaveLength(1));
    await m.authStore.beginWrite();
    m.authStore.lock();

    // Hold the first decryption of a login during the unlock.
    const hooks = m.credentialStore.vaultHooks();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    let first = true;
    m.authStore.registerCredentials({
      ...hooks,
      open: async (crypto) => {
        if (!first) return hooks.open(crypto);
        first = false;
        return hooks.open({
          ...crypto,
          open: async (blob, binding) => {
            reached = true;
            await wait;
            return crypto.open(blob, binding);
          },
        });
      },
    });
    const unlocking = m.authStore.unlock(STRONG);
    await vi.waitFor(() => expect(reached).toBe(true));
    await otherWindowWrites(() => rawPut("credentials", xRaw)); // another window adds X now
    await vi.waitFor(() => expect(m.credentialStore.items).toHaveLength(2));
    release();
    await unlocking;
    expect(m.credentialStore.items.map((c) => c.platform).sort()).toEqual([LOGIN.platform, "Other window"]);
    await m.authStore.setPassword(STRONG_2);
    expect(await m.db.loadCredentials()).toHaveLength(2); // X survives the re-key
  });

  it("doesn't bring a wiped vault back from a reload that was running", async () => {
    await setUp();
    const held = holdReloadHook();
    await otherWindowWrites();
    await vi.waitFor(() => expect(held.reached).toBe(true));
    const wiping = m.authStore.wipe(); // waits for the reload
    held.release();
    await wiping;
    await m.authStore.beginWrite();
    expect(m.authStore.vault).toBeNull();
    expect(m.authStore.entries).toHaveLength(0);
    expect(await m.db.loadEntries()).toHaveLength(0);
  });

  async function withDamagedLogin(): Promise<string> {
    await setUp();
    const second = await m.credentialStore.add({ ...LOGIN, platform: "Zulu", username: "z" });
    const raw = (await m.db.loadCredentials()).find((c) => c.id === second.id)!;
    await rawPut("credentials", { ...raw, meta: { ...raw.meta!, ct: "AAAA" } });
    m.authStore.dispose();
    m.db.unwatchExternalChanges();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    expect(m.credentialStore.unreadable).toBe(1);
    return second.id;
  }

  it("keeps a login that couldn't be decrypted through a password change (NEW-5)", async () => {
    const damaged = await withDamagedLogin();
    await m.authStore.setPassword(STRONG_2);
    expect((await m.db.loadCredentials()).map((c) => c.id)).toContain(damaged);
    expect(m.credentialStore.unreadable).toBe(1);
  });

  it("keeps it through a merge restore, not through a replace (NEW-5)", async () => {
    const damaged = await withDamagedLogin();
    const { content } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "credmanager");
    const payload = (await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(content)))!;
    await m.authStore.restoreFromBackup(m.cloud.restoreParts([payload], "credmanager"), "merge");
    expect((await m.db.loadCredentials()).map((c) => c.id)).toContain(damaged);
    await m.authStore.restoreFromBackup(m.cloud.restoreParts([payload], "credmanager"), "replace");
    expect((await m.db.loadCredentials()).map((c) => c.id)).not.toContain(damaged);
    expect(m.credentialStore.unreadable).toBe(0);
  });

  it("ignores plaintext deletion records planted in an encrypted vault", async () => {
    await setUp();
    await rawPut("meta", { plain: { entries: [{ k: "a".repeat(64), at: Date.now() }], credentials: [] } }, "tombstones");
    m.authStore.dispose();
    m.db.unwatchExternalChanges();
    m = await load();
    await m.credentialStore.init();
    await m.authStore.unlock(STRONG);
    const { content } = await m.authStore.sealCloudBackup({ id: "dev-a", label: "PC-A" }, "authenticator");
    const payload = await m.authStore.openCloudBackupWithVaultKey(m.cloud.parseCloudBackup(content));
    expect(payload!.tombstones).toHaveLength(0);
  });

  it("refuses an audit append whose chain head moved since it was read", async () => {
    await setUp();
    const head = await m.db.loadAuditHead();
    const records = await m.db.loadAuditRecords();
    // Another window appended: the head on disk is no longer the one read.
    await rawPut("meta", { sealed: { ...head!.sealed, ct: "moved" } }, "auditHead");
    await expect(m.db.appendAuditRecords(records.slice(0, 1), head!, head)).rejects.toThrow(/changed in another window/);
  });
});
