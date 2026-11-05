import type { TasraIdentity, TasraApplication } from '@t3foundry/tasra-sdk/app';
import type { TypedDataSigner } from '@t3foundry/tasra-sdk/oid4vp';
import { createIdentity, createLocalWallet } from '@t3foundry/tasra-sdk/app';
import { createContext, use, useLayoutEffect, useState, type ReactNode } from 'react';

import { client } from '@/lib/client';

import { createCredentialCache } from './credential-cache';
import { decryptedCache } from './decrypt-cache';
import { getDeployment } from './deployment';
import { getTasraApplication } from './tasra-application';

/**
 * The value the context hands down: everything a component needs to work with
 * Tasra for the current login session.
 */
export interface TasraSessionValue {
  /** The session identity (DID) whose lifetime matches the provider. */
  identity: TasraIdentity;
  /** EIP-712 off-chain signer derived from the session wallet. Never broadcasts transactions. */
  signer: TypedDataSigner;
  /**
   * Returns (and memoises) the SD-JWT credential for `slotId`.
   *
   * Deduplicates in-flight requests and evicts failures so the caller can retry
   * after an expired session without restarting the app.
   */
  getCredential: (slotId: string) => Promise<string>;
  /** The Tasra application client, shared across the app. */
  application: TasraApplication;
}

const TasraSessionContext = createContext<TasraSessionValue | null>(null);

/**
 * Mounted once per login session, above the room tree. Creates a session
 * identity and signing wallet, and wires up the credential cache so every
 * component that needs to decrypt can reach it without threading props.
 */
export const TasraProvider = ({ children }: { children: ReactNode }) => {
  // The identity is created and destroyed inside one effect, never in state.
  // React StrictMode double-mounts every component in development (mount →
  // cleanup → mount), and `TasraIdentity.destroy()` is terminal: a provider
  // that created the identity in `useState` and destroyed it in a cleanup would
  // hand the second mount a dead identity, which every `identity.holder` access
  // then rejects with "Identity has been destroyed". Creating a fresh key pair
  // per effect run — and letting only that run's cleanup destroy it — is what
  // keeps the two passes independent.
  const [session, setSession] = useState<TasraSessionValue | null>(null);

  // `useLayoutEffect` rather than `useEffect` so the first render that shows
  // children already carries the session, with no blank frame in between.
  useLayoutEffect(() => {
    const identity = createIdentity();
    // A fresh random signing key is generated per session. The verifier no
    // longer checks the creator identity for these operations, so any valid
    // signer is accepted.
    const signer = createLocalWallet(getDeployment()).signer;
    const cache = createCredentialCache(async (id) => {
      const callStart = performance.now();
      const result = await client.tasra.issueDocumentReader({ slotId: id, did: identity.did });
      console.log(`[tasra:timing]   HTTP POST /tasra/credentials/document-reader round trip: ${(performance.now() - callStart).toFixed(1)}ms`);
      return result.credential;
    });

    setSession({
      identity,
      signer,
      getCredential: (slotId) => cache.get(slotId),
      application: getTasraApplication(),
    });

    return () => {
      identity.destroy();
      // Plaintext lives for the session only; a later login starts clean.
      decryptedCache.clear();
    };
  }, []);

  // The pre-effect render has no session. Render nothing rather than children,
  // which would trip `useTasraSession`'s guard on a null context.
  if (!session) return null;

  return <TasraSessionContext value={session}>{children}</TasraSessionContext>;
};

/**
 * The per-session Tasra state: identity, signer, credential cache and application.
 *
 * Throws if used outside a `<TasraProvider>` — the provider is designed to be
 * mounted once per login session.
 */
export const useTasraSession = (): TasraSessionValue => {
  const session = use(TasraSessionContext);

  if (!session) {
    throw new Error('useTasraSession must be used inside a <TasraProvider>');
  }

  return session;
};
