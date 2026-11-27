import type { TasraIdentity, TasraApplication } from '@t3foundry/tasra-sdk/app';
import type { TypedDataSigner } from '@t3foundry/tasra-sdk/oid4vp';
import { createIdentity, createLocalWallet } from '@t3foundry/tasra-sdk/app';
import { createContext, use, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

import { client } from '@/lib/client';

import { createChannelUnwrapper, type ChannelUnwrapper } from './channel-unwrap';
import { createCredentialCache } from './credential-cache';
import type { UnwrapDataKey } from './crypto';
import { decryptedCache } from './decrypt-cache';
import { decryptFailures } from './decrypt-failures';
import { getDeployment } from './deployment';
import { channelUnwrapDeps } from './session-config';
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
  /**
   * Recovers a message's AES data key through the channel's decrypt session:
   * the first message of a slot presents the reader credential and opens a
   * session grant, later messages reuse it, and messages that arrive together
   * share one keeper request. The reader pays nothing and needs no key of the
   * slot's owner.
   */
  unwrapDataKey: UnwrapDataKey;
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

  // Load persisted decryption cache from IndexedDB before the first render
  // that shows messages. A failure is silent: the app starts with an empty
  // cache and decrypts on demand.
  useEffect(() => {
    void decryptedCache.load();
  }, []);

  // `useLayoutEffect` rather than `useEffect` so the first render that shows
  // children already carries the session, with no blank frame in between.
  useLayoutEffect(() => {
    const identity = createIdentity();
    // The reader's own signing key: a fresh random one per login session. Any
    // key may open a decrypt session; the slot's rule decides whether the
    // presented credential is admitted.
    const signer = createLocalWallet(getDeployment()).signer;
    const cache = createCredentialCache(async (id) => {
      const callStart = performance.now();
      const result = await client.tasra.issueDocumentReader({ slotId: id, did: identity.did });
      console.log(`[tasra:timing]   HTTP POST /tasra/credentials/document-reader round trip: ${(performance.now() - callStart).toFixed(1)}ms`);
      return result.credential;
    });

    // Built on first use, so a missing deployment setting fails the decrypt that needs it
    // (with a message the timeline can show) rather than the whole session.
    let unwrapper: ChannelUnwrapper | undefined;
    const unwrapDataKey: UnwrapDataKey = async (slotId, envelope) => {
      unwrapper ??= createChannelUnwrapper(
        channelUnwrapDeps({ signer, identity, getCredential: (id) => cache.get(id) }),
      );
      return unwrapper.unwrap(slotId, envelope);
    };

    setSession({
      identity,
      signer,
      getCredential: (slotId) => cache.get(slotId),
      unwrapDataKey,
      application: getTasraApplication(),
    });

    return () => {
      // Revokes every channel session at the verifiers before the keys go.
      unwrapper?.dispose();
      identity.destroy();
      // Plaintext lives for the session only; a later login starts clean.
      decryptedCache.clear();
      decryptFailures.clear();
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
