/**
 * Why a message could not be decrypted automatically, kept in memory for the
 * login session so the timeline can say so and offer a retry.
 *
 * Without it an auto-decrypt failure is only logged: the message would read
 * "Decrypting…" for ever, and every timeline update would send it again.
 *
 * Keyed by `recordId`, like the plaintext cache. Components subscribe via
 * {@link subscribe}, typically through React's `useSyncExternalStore`.
 */
export interface DecryptFailure {
  /** The reason, for display next to "cannot decrypt". */
  message: string;
  /** True when the channel slot's balance is exhausted: only its owner can fix that. */
  balance: boolean;
  /** How many automatic attempts have failed. */
  attempts: number;
}

/** A transient failure earns this many automatic attempts; after that the user retries by hand. */
export const MAX_AUTO_ATTEMPTS = 2;

const failures = new Map<string, DecryptFailure>();
const listeners = new Set<() => void>();

const notify = () => {
  listeners.forEach((fn) => fn());
};

export const decryptFailures = {
  get(recordId: string): DecryptFailure | undefined {
    return failures.get(recordId);
  },

  /** Records one more failed automatic attempt for `recordId`. */
  record(recordId: string, failure: { message: string; balance: boolean }): void {
    failures.set(recordId, { ...failure, attempts: (failures.get(recordId)?.attempts ?? 0) + 1 });
    notify();
  },

  /**
   * Whether the auto-decrypter may send `recordId` again by itself. An exhausted
   * channel balance is never retried automatically: nothing this client does
   * changes it.
   */
  mayRetry(recordId: string): boolean {
    const failure = failures.get(recordId);
    return !failure || (!failure.balance && failure.attempts < MAX_AUTO_ATTEMPTS);
  },

  /** Forgets a failure: the message decrypted, or the user asked to try again. */
  remove(recordId: string): void {
    if (failures.delete(recordId)) notify();
  },

  /** Forgets everything. Does NOT notify subscribers because the session is ending. */
  clear(): void {
    failures.clear();
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
