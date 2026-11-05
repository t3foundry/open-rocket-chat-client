/**
 * A memoised credential fetcher that deduplicates in-flight requests per slot
 * and evicts failures so the next call retries rather than replaying the error.
 *
 * Extracted from the Tasra provider so it can be tested with a fake `issue`.
 */
export type CredentialIssuer = (slotId: string) => Promise<string>;

export interface CredentialCache {
  /** Returns the (possibly in-flight) credential for `slotId`. */
  get(slotId: string): Promise<string>;
}

export const createCredentialCache = (issue: CredentialIssuer): CredentialCache => {
  const cache = new Map<string, Promise<string>>();

  return {
    get(slotId: string): Promise<string> {
      const existing = cache.get(slotId);
      if (existing) {
        console.log(`[tasra:timing] credential cache HIT for slot, reusing in-flight promise`);
        return existing;
      }

      console.log(`[tasra:timing] credential cache MISS — issuing new credential from gateway`);
      const issueStart = performance.now();
      const promise = issue(slotId)
        .then((credential) => {
          console.log(`[tasra:timing]   gateway issueDocumentReader call: ${(performance.now() - issueStart).toFixed(1)}ms`);
          return credential;
        })
        .catch((error: unknown) => {
          // Evict on failure so the next call retries rather than replaying the
          // rejected promise.
          cache.delete(slotId);
          throw error;
        });

      cache.set(slotId, promise);
      return promise;
    },
  };
};
