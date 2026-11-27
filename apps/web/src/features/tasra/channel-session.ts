import { openDecryptSession, type DecryptSessionConfig, type TasraIdentity } from '@t3foundry/tasra-sdk/app';
import { assertRegisteredWalletRequest } from '@t3foundry/tasra-sdk/chain';
import {
  buildResponse,
  defaultKeyResolver,
  fetchRequestObject,
  planPresentation,
  submitResponse,
} from '@t3foundry/tasra-sdk/oid4vp';

import type { ChannelUnwrapDeps } from './channel-unwrap';

/**
 * Opens a channel's decrypt session: the one place the reader's pieces meet.
 *
 * A reader needs the slot id, a signing key of its own (ANY key: the slot's
 * rule decides whether the credential is admitted), its reader credential and
 * holder key, an approved verifier agent, and a store. It needs no slot-creator
 * key, no gas, no rule and no rule salt.
 *
 * Environment-neutral: the store, the agent transport and the fetch
 * implementations arrive in {@link ChannelSessionConfig}, so the browser
 * provider and the Node harness share this code. `walletFetch` carries the
 * wallet's own requests of one session too: its Request Object, the agent's DID
 * document and the response.
 */

/** The verifier-agent session `openDecryptSession` hands the wallet step. */
type WalletSession = Parameters<DecryptSessionConfig['present']>[0];

export interface ChannelSessionConfig extends Omit<DecryptSessionConfig, 'present'> {
  /** The session identity: it holds the holder key the reader credential is bound to. */
  identity: Pick<TasraIdentity, 'holder'>;
  /** The reader credential (SD-JWT VC) for a slot, as the gateway issues it. */
  getCredential: (slotId: string) => Promise<string>;
  /** Session lifetimes requested from the platform (it clamps them to its bounds). */
  lifetimes?: { accessTtlSecs?: number; idleTimeoutSecs?: number; absoluteTtlSecs?: number };
}

/**
 * The wallet step: answer a session's signed request with the reader credential.
 *
 * `openDecryptSession` has already verified this session's Request Object
 * against the verifier draw anchored on chain. The request is read again here
 * (the SDK does not hand it over), verified under the signer's published key and
 * bound to this session's signed operation before anything is disclosed.
 */
export async function presentReaderCredential(
  session: WalletSession,
  options: { identity: Pick<TasraIdentity, 'holder'>; credential: string; fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal;
  const request = await fetchRequestObject(session.requestUri, {
    fetchImpl,
    resolveKey: defaultKeyResolver({ fetchImpl }),
    ...(signal ? { signal } : {}),
  });
  assertRegisteredWalletRequest(session, request, await session.poll(signal));

  const plan = planPresentation(request, [{ sdJwt: options.credential }]);
  if (!plan.chosen) throw new Error('cannot decrypt: the reader credential does not answer the channel rule');
  const built = buildResponse({ ro: request, candidate: plan.chosen, holder: options.identity.holder, disclose: 'all' });
  if (!built.encrypted || !built.form.response) throw new Error('cannot decrypt: the presentation must be encrypted');
  signal?.throwIfAborted();
  await submitResponse(request, built, fetchImpl);
}

/** {@link ChannelUnwrapDeps.openSession} over the SDK's `openDecryptSession`. */
export function channelSessionOpener(config: ChannelSessionConfig): ChannelUnwrapDeps['openSession'] {
  const { identity, getCredential, lifetimes, ...shared } = config;
  const walletFetch = (session: WalletSession) => config.walletFetch?.(session) ?? config.fetchImpl ?? fetch;
  return (slotId, first) =>
    openDecryptSession(
      {
        ...shared,
        present: async (session, signal) =>
          presentReaderCredential(session, {
            identity,
            credential: await getCredential(slotId),
            fetchImpl: walletFetch(session),
            ...(signal ? { signal } : {}),
          }),
      },
      {
        slots: [slotId],
        first: { slot: slotId, ciphertext: first.ciphertext, identity: first.identity },
        description: 'Read an encrypted channel',
        ...lifetimes,
        // A session ends (idle, absolute lifetime, revocation, a moved verifier draw). The SDK then
        // presents once more under the message that found it ended, single-flight per ended session.
        presentAgainOnEnd: true,
      },
    );
}
