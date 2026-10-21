/**
 * IndexedDB session recovery for JSON Studio.
 *
 * This is the module's ONLY storage boundary. It persists the working
 * document (and the secondary schema/diff texts) so an accidental reload or
 * crash never loses work — the same deliberate exception to the app's
 * no-storage rule that the Authenticator makes, documented in SECURITY.md.
 * Everything stays in the local `coretools-json-studio` database; nothing is
 * transmitted anywhere.
 *
 * Recovery is a convenience, not a requirement: where storage is blocked
 * (private windows) every call quietly does nothing and the studio works
 * without it.
 */

import { connection, requestResult, txDone } from "../idb";

const DB_NAME = "coretools-json-studio";
const DB_VERSION = 1;
const STORE = "session";
const KEY = "current";

/** Sessions larger than this are not persisted (recovery isn't worth 100MB writes). */
export const MAX_PERSIST_CHARS = 5_000_000;

/** A recovery copy older than this is deleted unread (audit F-15). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface StudioSession {
  /** Main editor content. */
  docText: string;
  /** Secondary pane content (schema editor / right diff document). */
  schemaText: string;
  rightText: string;
  /** Active tool tab id. */
  tool: string;
  updatedAt: number;
}

const db = connection(DB_NAME, DB_VERSION, (database) => {
  if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
});

export async function loadSession(): Promise<StudioSession | null> {
  try {
    const database = await db();
    const store = database.transaction(STORE).objectStore(STORE);
    const session = await requestResult(store.get(KEY) as IDBRequest<StudioSession | undefined>);
    // Pasted content shouldn't linger on disk: recovery is for today's work.
    if (session && Date.now() - session.updatedAt > SESSION_TTL_MS) {
      await clearSession();
      return null;
    }
    return session ?? null;
  } catch {
    return null; // storage unavailable: no recovery (see above)
  }
}

export async function saveSession(session: StudioSession): Promise<void> {
  if (
    session.docText.length + session.schemaText.length + session.rightText.length >
    MAX_PERSIST_CHARS
  ) {
    // Too big to keep: an older, smaller copy mustn't be left behind (L6).
    await clearSession();
    return;
  }
  try {
    const database = await db();
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session, KEY);
    await txDone(tx);
  } catch {
    // Storage unavailable: no recovery (see above).
  }
}

/**
 * Delete a recovery copy past its expiry. Run at app start, so expired
 * content doesn't stay on disk until JSON-Studio is next opened (L6).
 */
export async function purgeExpiredSession(): Promise<void> {
  await loadSession(); // deletes it when expired
}

export async function clearSession(): Promise<void> {
  try {
    const database = await db();
    const tx = database.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    await txDone(tx);
  } catch {
    // Storage unavailable: nothing was stored to clear.
  }
}
