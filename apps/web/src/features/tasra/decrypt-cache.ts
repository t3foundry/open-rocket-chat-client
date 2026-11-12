import { set as idbSet, del as idbDel } from 'idb-keyval';

/**
 * In-memory plaintext cache for decrypted Tasra messages, backed by IndexedDB
 * so decrypted text survives page reloads.
 *
 * Keyed by `recordId` so the same encrypted record is never unwrapped twice in
 * a single session. A record with a newer version displaces the old entry.
 *
 * Uses a two-tier cache:
 * - **L1 (in-memory Map)**: synchronous reads, always up-to-date
 * - **L2 (IndexedDB)**: async persistence, survives reloads
 *
 * Components subscribe via {@link subscribe} to be notified of cache writes,
 * typically through React's `useSyncExternalStore`.
 */
export interface DecryptedEntry {
  text: string;
  version: number;
}

const IDB_KEY_PREFIX = 'tasra:decrypted:';

const l1 = new Map<string, DecryptedEntry>();

/** Subscribers notified on every `set`. */
const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((fn) => fn());
};

const idbKey = (recordId: string): string => `${IDB_KEY_PREFIX}${recordId}`;

export const decryptedCache = {
  get(recordId: string): DecryptedEntry | undefined {
    return l1.get(recordId);
  },

  set(recordId: string, entry: DecryptedEntry): void {
    l1.set(recordId, entry);
    // Persist to IndexedDB — fire-and-forget. A write failure is non-fatal:
    // the plaintext is still cached in memory for the rest of the session.
    void idbSet(idbKey(recordId), entry);
    notify();
  },

  /**
   * Populates the in-memory cache from IndexedDB on startup.
   *
   * Call once early in the app lifecycle, before any messages render. A failure
   * is silent: the app starts with an empty cache and decrypts on demand.
   */
  async load(): Promise<void> {
    try {
      // idb-keyval has no "list all keys" API, so we iterate over the IDB
      // object store directly. The store name is hard-coded: idb-keyval uses
      // 'keyval' for its default store.
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // The store may not exist in a fresh profile.
      if (!db.objectStoreNames.contains('keyval')) {
        db.close();
        return;
      }

      const tx = db.transaction('keyval', 'readonly');
      const store = tx.objectStore('keyval');

      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = cursor.key as string;
          if (key.startsWith(IDB_KEY_PREFIX)) {
            const recordId = key.slice(IDB_KEY_PREFIX.length);
            const entry = cursor.value as DecryptedEntry;
            if (entry && typeof entry.text === 'string') {
              l1.set(recordId, entry);
            }
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });

      db.close();
    } catch {
      // Private browsing modes reject IndexedDB entirely; nothing to load.
    }
  },

  /** Evicts a single entry from both tiers. */
  remove(recordId: string): void {
    l1.delete(recordId);
    void idbDel(idbKey(recordId));
  },

  /**
   * Evicts all entries — useful on logout or when the credential expires.
   * Does NOT notify subscribers because the session is ending.
   */
  clear(): void {
    l1.clear();
    // Remove all tasra-prefixed keys from IndexedDB.
    try {
      const req = indexedDB.open('keyval-store');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('keyval')) {
          db.close();
          return;
        }
        const tx = db.transaction('keyval', 'readwrite');
        const store = tx.objectStore('keyval');
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if ((cursor.key as string).startsWith(IDB_KEY_PREFIX)) {
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => db.close();
      };
    } catch {
      // Private browsing — nothing was written anyway.
    }
  },

  /**
   * Subscribes to cache changes. Returns an unsubscribe function.
   *
   * For `useSyncExternalStore`:
   * ```ts
   * const value = useSyncExternalStore(decryptedCache.subscribe, () => decryptedCache.get(recordId));
   * ```
   */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};