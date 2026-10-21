/**
 * The small IndexedDB layer both local databases share: the vault
 * (authenticator/db.ts) and JSON-Studio recovery (json-studio/db.ts).
 */

/** A transaction's outcome. Always rejects with an Error, never with null. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("The change couldn't be saved"));
    tx.onabort = () => reject(tx.error ?? new Error("The change was cancelled"));
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The data couldn't be read"));
  });
}

/**
 * A lazily opened connection shared by every caller. A failed open isn't
 * remembered — the next call tries again — and a connection that goes away
 * (another tab upgrading the schema, the browser closing it) is reopened on
 * next use. An upgrade held up by an older copy of the app still open in
 * another tab fails with a message saying so, instead of waiting forever.
 */
export function connection(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
  openError: (error: DOMException | null) => unknown = (error) => error,
): () => Promise<IDBDatabase> {
  let current: Promise<IDBDatabase> | null = null;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onblocked = () =>
        reject(
          new Error(
            "An older version of CoreTools is still open in another window or tab. Close it, then reload this one.",
          ),
        );
      request.onsuccess = () => {
        const database = request.result;
        // Let a newer schema upgrade instead of being blocked by this connection.
        database.onversionchange = () => {
          database.close();
          current = null;
        };
        database.onclose = () => (current = null);
        resolve(database);
      };
      request.onerror = () => reject(openError(request.error) ?? new Error("The database couldn't be opened"));
    });
  return () => {
    current ??= open().catch((error: unknown) => {
      current = null;
      throw error;
    });
    return current;
  };
}

/**
 * A plain-data copy for IndexedDB. Svelte's `$state` proxies aren't
 * structured-cloneable (so neither `put` nor `structuredClone` accepts
 * them); a JSON round trip unwraps them. Records here are JSON by design.
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
