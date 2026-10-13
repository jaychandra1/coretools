/**
 * IndexedDB session recovery for JSON Studio.
 *
 * This is the module's ONLY storage boundary. It persists the working
 * document (and the secondary schema/diff texts) so an accidental reload or
 * crash never loses work — the same deliberate exception to the app's
 * no-storage rule that the Authenticator makes, documented in SECURITY.md.
 * Everything stays in the local `coretools-json-studio` database; nothing is
 * transmitted anywhere.
 */

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

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function loadSession(): Promise<StudioSession | null> {
  try {
    const database = await db();
    const session = await new Promise<StudioSession | null>((resolve, reject) => {
      const request = database
        .transaction(STORE)
        .objectStore(STORE)
        .get(KEY) as IDBRequest<StudioSession | undefined>;
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    // Pasted content shouldn't linger on disk: recovery is for today's work.
    if (session && Date.now() - session.updatedAt > SESSION_TTL_MS) {
      await clearSession();
      return null;
    }
    return session;
  } catch {
    // Private windows / blocked storage: recovery is a convenience, not a
    // requirement — the studio works without it.
    return null;
  }
}

export async function saveSession(session: StudioSession): Promise<void> {
  if (
    session.docText.length + session.schemaText.length + session.rightText.length >
    MAX_PERSIST_CHARS
  ) {
    return;
  }
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(session, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Same rationale as loadSession.
  }
}

export async function clearSession(): Promise<void> {
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}
