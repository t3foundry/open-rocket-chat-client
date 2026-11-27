import type { GroupEnvelope } from '@t3foundry/tasra-sdk';
import { SessionEndedError, SessionMessageError } from '@t3foundry/tasra-sdk/app';

/**
 * Unwraps channel data keys through METERED decrypt sessions (Tasra SDK 0.5.0).
 *
 * A reader pays nothing and holds nothing the slot's owner holds. One credential
 * presentation opens a session grant for a channel slot; every later message is
 * authorized by that grant and a proof from a session key that never leaves this
 * client. The keepers meter the work against the slot's balance, which the
 * slot's owner funds.
 *
 * This module keeps ONE session per channel slot:
 *
 *  - the first message that needs a slot opens its session, and every message
 *    arriving meanwhile waits for that one opening (single-flight);
 *  - messages arriving within a few milliseconds of each other (a page of
 *    history) are collected and sent as one batch, so a page costs a few keeper
 *    requests instead of one per message;
 *  - each message settles on its own: a message the keepers refuse fails alone;
 *  - a session that ended is dropped, and the next message opens a new one. The
 *    opened session presents again by itself when it ends under a message, so
 *    this module never retries: a message is attempted once;
 *  - a slot whose balance does not cover its metered work is reported as
 *    {@link ChannelBalanceError} and never retried here.
 *
 * The module is environment-neutral and holds no network, storage or wallet
 * code: the session arrives through {@link ChannelUnwrapDeps.openSession}, so
 * the browser provider, a Node harness and the unit tests drive the same code.
 */

type Hex = `0x${string}`;

/** One wrapped data key: the KEM ciphertext and the identity it was encrypted under. */
export interface ChannelCiphertext {
  ciphertext: GroupEnvelope['ciphertext'];
  identity: Uint8Array;
}

/** One message's outcome in a batch: the data key, or the keepers' refusal. */
export type ChannelDecryptResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; error: string; refusals: readonly { status: number }[] };

/** The part of an open decrypt session this module uses (`DecryptSession` of the SDK satisfies it). */
export interface ChannelSession {
  decrypt(slot: Hex, message: ChannelCiphertext): Promise<Uint8Array>;
  decryptMany(slot: Hex, messages: readonly ChannelCiphertext[]): Promise<ChannelDecryptResult[]>;
  revoke(): Promise<void>;
  stop(): void;
}

/** Everything the unwrapper needs from its environment. */
export interface ChannelUnwrapDeps {
  /**
   * Open a decrypt session for `slotId` with one credential presentation that
   * names `first` (a session opens from a decrypt of one real ciphertext).
   */
  openSession: (slotId: Hex, first: ChannelCiphertext) => Promise<ChannelSession>;
  /** How long a message waits for neighbours before its batch is sent, ms. Default {@link BATCH_WINDOW_MS}. */
  batchWindowMs?: number;
  /** Most messages in one batch. Default {@link MAX_BATCH}, the keepers' limit per request. */
  maxBatch?: number;
  /** Observe phase timings (name, milliseconds). */
  onTiming?: (phase: string, ms: number) => void;
}

/** What a reader calls per message. */
export interface ChannelUnwrapper {
  /** Recover the AES data key wrapped in `envelope`. The caller zeroes the result after use. */
  unwrap(slotId: Hex, envelope: GroupEnvelope): Promise<Uint8Array>;
  /** Revoke every session and refuse further messages. Call when the login session ends. */
  dispose(): void;
}

/** Messages arriving within this many milliseconds share one keeper request. */
export const BATCH_WINDOW_MS = 8;
/** The keepers accept at most this many messages per request. */
export const MAX_BATCH = 64;

/**
 * The channel slot's balance does not cover its metered work (a keeper answered
 * HTTP 402). Nothing ran. Only the slot's owner can fund the slot, so the
 * message is not sent again by itself.
 */
export class ChannelBalanceError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This channel's balance is exhausted. Ask the channel owner to fund it, then try again.", options);
    this.name = 'ChannelBalanceError';
  }
}

/** True when a decrypt failed because the channel slot's balance is exhausted. */
export const isChannelBalanceError = (error: unknown): error is ChannelBalanceError =>
  error instanceof ChannelBalanceError;

interface Pending {
  message: ChannelCiphertext;
  resolve: (dataKey: Uint8Array) => void;
  reject: (error: unknown) => void;
}

/** Per-slot state: its session (once opened), the opening in progress, and the messages waiting for a batch. */
interface SlotState {
  slotId: Hex;
  session?: ChannelSession;
  /** Single-flight guard: the opening in progress, shared by every message that arrives meanwhile. */
  opening?: Promise<ChannelSession>;
  queue: Pending[];
  timer?: ReturnType<typeof setTimeout>;
}

const HTTP_PAYMENT_REQUIRED = 402;

/** A refused batch item as the error a single decrypt would have thrown. */
const refusalError = (result: Extract<ChannelDecryptResult, { ok: false }>): Error =>
  result.refusals.some((refusal) => refusal.status === HTTP_PAYMENT_REQUIRED)
    ? new ChannelBalanceError({ cause: new Error(result.error) })
    : new Error(`cannot decrypt: the keepers refused this message (${result.error})`);

/** A thrown session error as the error the timeline shows. */
const thrownError = (error: unknown): unknown =>
  error instanceof SessionMessageError && error.slotBalance ? new ChannelBalanceError({ cause: error }) : error;

export function createChannelUnwrapper(deps: ChannelUnwrapDeps): ChannelUnwrapper {
  const batchWindowMs = deps.batchWindowMs ?? BATCH_WINDOW_MS;
  const maxBatch = Math.max(1, Math.min(deps.maxBatch ?? MAX_BATCH, MAX_BATCH));
  const slots = new Map<string, SlotState>();
  let disposed = false;
  const timing = (phase: string, from: number) => deps.onTiming?.(phase, performance.now() - from);

  const stateOf = (slotId: Hex): SlotState => {
    const key = slotId.toLowerCase();
    let state = slots.get(key);
    if (!state) {
      state = { slotId, queue: [] };
      slots.set(key, state);
    }
    return state;
  };

  /** Best-effort end of a session this module no longer uses. */
  const end = (session: ChannelSession, revoke: boolean): void => {
    try {
      if (revoke) void session.revoke().catch(() => undefined);
      else session.stop();
    } catch {
      // A session that already ended has nothing left to stop.
    }
  };

  /** The slot's session: the open one, the opening in progress, or a new opening for `first`. */
  const sessionFor = (state: SlotState, first: ChannelCiphertext): Promise<ChannelSession> => {
    if (state.session) return Promise.resolve(state.session);
    if (state.opening) return state.opening;
    const start = performance.now();
    const opening = deps
      .openSession(state.slotId, first)
      .then((session) => {
        timing('session-open', start);
        if (disposed) {
          // The login session ended while the wallet step ran: nothing may use this grant.
          end(session, true);
          throw new Error('cannot decrypt: the session has ended');
        }
        state.session = session;
        return session;
      })
      .finally(() => {
        // A failed opening is not kept: the next message asks again.
        if (state.opening === opening) state.opening = undefined;
      });
    state.opening = opening;
    return opening;
  };

  /** Send one batch: every message settles on its own. */
  const send = async (state: SlotState, batch: Pending[]): Promise<void> => {
    let session: ChannelSession | undefined;
    try {
      session = await sessionFor(state, batch[0]!.message);
      const start = performance.now();
      if (batch.length === 1) {
        const only = batch[0]!;
        only.resolve(await session.decrypt(state.slotId, only.message));
        timing('session-decrypt', start);
        return;
      }
      const results = await session.decryptMany(
        state.slotId,
        batch.map((pending) => pending.message),
      );
      timing(`session-decrypt-batch(${batch.length})`, start);
      batch.forEach((pending, index) => {
        const result = results[index];
        if (!result) pending.reject(new Error('cannot decrypt: the keepers returned no result for this message'));
        else if (result.ok) pending.resolve(result.plaintext);
        else pending.reject(refusalError(result));
      });
    } catch (error) {
      // The session ended and could not continue (it presents again by itself, once, when it
      // ends under a message). Drop it: the NEXT message opens a new one. Nothing is retried here.
      if (error instanceof SessionEndedError && session && state.session === session) {
        state.session = undefined;
        end(session, false);
      }
      // Settling twice is a no-op, so a throw after some messages settled reaches only the rest.
      const shown = thrownError(error);
      for (const pending of batch) pending.reject(shown);
    }
  };

  /** Send what is waiting, at most `maxBatch` per request. */
  const flush = (state: SlotState): void => {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    while (state.queue.length > 0) void send(state, state.queue.splice(0, maxBatch));
  };

  return {
    unwrap(slotId, envelope) {
      if (disposed) return Promise.reject(new Error('cannot decrypt: the session has ended'));
      const state = stateOf(slotId);
      return new Promise<Uint8Array>((resolve, reject) => {
        state.queue.push({ message: { ciphertext: envelope.ciphertext, identity: envelope.identity }, resolve, reject });
        // A full batch goes at once; otherwise the first message of a window starts its timer.
        if (state.queue.length >= maxBatch) flush(state);
        else state.timer ??= setTimeout(() => flush(state), batchWindowMs);
      });
    },

    dispose() {
      disposed = true;
      for (const state of slots.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = undefined;
        for (const pending of state.queue.splice(0)) pending.reject(new Error('cannot decrypt: the session has ended'));
        // Logout revokes the grant at the verifiers rather than letting it run out.
        if (state.session) end(state.session, true);
        state.session = undefined;
      }
      slots.clear();
    },
  };
}
