/**
 * In-memory plaintext cache for decrypted Tasra messages.
 *
 * Keyed by `recordId` so the same encrypted record is never unwrapped twice in
 * a single session. A record with a newer version displaces the old entry.
 */
export interface DecryptedEntry {
  text: string;
  version: number;
}

const cache = new Map<string, DecryptedEntry>();

export const decryptedCache = {
  get(recordId: string): DecryptedEntry | undefined {
    return cache.get(recordId);
  },

  set(recordId: string, entry: DecryptedEntry): void {
    cache.set(recordId, entry);
  },

  /** Evicts all entries — useful on logout or when the credential expires. */
  clear(): void {
    cache.clear();
  },
};
