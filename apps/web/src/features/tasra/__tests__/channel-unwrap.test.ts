import type { GroupEnvelope } from '@t3foundry/tasra-sdk';
import { SessionEndedError, SessionMessageError } from '@t3foundry/tasra-sdk/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BATCH_WINDOW_MS,
  ChannelBalanceError,
  createChannelUnwrapper,
  isChannelBalanceError,
  MAX_BATCH,
  type ChannelCiphertext,
  type ChannelDecryptResult,
  type ChannelSession,
} from '../channel-unwrap';

const SLOT = `0x${'ab'.repeat(32)}` as const;
const OTHER_SLOT = `0x${'cd'.repeat(32)}` as const;

/** An envelope whose identity is its message number: the fake session answers with it. */
const envelope = (n: number): GroupEnvelope =>
  ({
    slotId: new Uint8Array(32),
    identity: new Uint8Array([n]),
    ciphertext: { n } as unknown as GroupEnvelope['ciphertext'],
    epoch: 1n,
  }) satisfies GroupEnvelope;

const numberOf = (message: ChannelCiphertext): number => message.identity[0]!;
const keyOf = (n: number): Uint8Array => new Uint8Array([n, n, n]);

type Refusal = Extract<ChannelDecryptResult, { ok: false }>;
const refused = (status: number, error = 'refused'): Refusal => ({ ok: false, error, refusals: [{ status }] });

/** What a keeper refusal looks like when a single decrypt throws it. */
const messageError = (status: number): SessionMessageError =>
  new SessionMessageError({
    ok: false,
    error: `status ${status}`,
    codes: [`status ${status}`],
    refusals: [{ nodeUrl: 'https://keeper.example', status, code: `status ${status}`, scope: 'item' }],
    stale: false,
  });

/** A fake session: records every keeper request, and answers from `outcome` (default: the data key). */
const fakeSession = (outcome: (n: number) => Uint8Array | Refusal | Error = keyOf) => {
  const calls: { kind: 'decrypt' | 'decryptMany'; numbers: number[] }[] = [];
  const session: ChannelSession & { revoked: number; stopped: number } = {
    revoked: 0,
    stopped: 0,
    async decrypt(_slot, message) {
      calls.push({ kind: 'decrypt', numbers: [numberOf(message)] });
      const result = outcome(numberOf(message));
      if (result instanceof Error) throw result;
      if (result instanceof Uint8Array) return result;
      throw new Error(result.error);
    },
    async decryptMany(_slot, messages) {
      calls.push({ kind: 'decryptMany', numbers: messages.map(numberOf) });
      return messages.map((message) => {
        const result = outcome(numberOf(message));
        if (result instanceof Error) throw result;
        return result instanceof Uint8Array ? { ok: true as const, plaintext: result } : result;
      });
    },
    async revoke() {
      session.revoked += 1;
    },
    stop() {
      session.stopped += 1;
    },
  };
  return { session, calls };
};

/** Let the batch window pass and every settled promise run. */
const settle = async (ms = BATCH_WINDOW_MS): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createChannelUnwrapper', () => {
  it('opens one session for concurrent first messages and names the first of them', async () => {
    const { session, calls } = fakeSession();
    let release!: (opened: ChannelSession) => void;
    const openSession = vi.fn(
      (_slot: `0x${string}`, _first: ChannelCiphertext) => new Promise<ChannelSession>((resolve) => (release = resolve)),
    );
    const unwrapper = createChannelUnwrapper({ openSession, maxBatch: 2 });

    // Five messages: three keeper requests (2 + 2 + 1), all waiting on ONE opening.
    const keys = [1, 2, 3, 4, 5].map((n) => unwrapper.unwrap(SLOT, envelope(n)));
    await settle();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]![0]).toBe(SLOT);
    expect(numberOf(openSession.mock.calls[0]![1])).toBe(1);
    expect(calls).toHaveLength(0);

    release(session);
    expect(await Promise.all(keys)).toEqual([1, 2, 3, 4, 5].map(keyOf));
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.numbers)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('opens a session per slot, case-insensitively, and reuses it for later messages', async () => {
    const openSession = vi.fn(async () => fakeSession().session);
    const unwrapper = createChannelUnwrapper({ openSession });

    const first = unwrapper.unwrap(SLOT, envelope(1));
    await settle();
    await first;
    const later = unwrapper.unwrap(SLOT.toUpperCase().replace('0X', '0x') as `0x${string}`, envelope(2));
    const other = unwrapper.unwrap(OTHER_SLOT, envelope(3));
    await settle();
    await Promise.all([later, other]);

    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it('sends messages that arrive within the window as one batch, and a lone message as a single decrypt', async () => {
    const { session, calls } = fakeSession();
    const unwrapper = createChannelUnwrapper({ openSession: async () => session });

    const page = [1, 2, 3].map((n) => unwrapper.unwrap(SLOT, envelope(n)));
    // Nothing is sent before the window closes.
    await settle(BATCH_WINDOW_MS - 1);
    expect(calls).toHaveLength(0);
    await settle(1);
    expect(await Promise.all(page)).toEqual([1, 2, 3].map(keyOf));

    const live = unwrapper.unwrap(SLOT, envelope(4));
    await settle();
    expect(await live).toEqual(keyOf(4));

    expect(calls).toEqual([
      { kind: 'decryptMany', numbers: [1, 2, 3] },
      { kind: 'decrypt', numbers: [4] },
    ]);
  });

  it('sends a full batch at once, without waiting for the window', async () => {
    const { session, calls } = fakeSession();
    const unwrapper = createChannelUnwrapper({ openSession: async () => session });

    const numbers = Array.from({ length: MAX_BATCH + 1 }, (_, index) => index);
    const keys = numbers.map((n) => unwrapper.unwrap(SLOT, envelope(n)));
    await settle(0);
    expect(calls.map((call) => call.numbers.length)).toEqual([MAX_BATCH]);

    await settle();
    await Promise.all(keys);
    expect(calls.map((call) => call.numbers.length)).toEqual([MAX_BATCH, 1]);
  });

  it('fails one undecryptable message without failing its neighbours', async () => {
    const { session, calls } = fakeSession((n) => (n === 2 ? refused(403, 'forbidden') : keyOf(n)));
    const unwrapper = createChannelUnwrapper({ openSession: async () => session });

    const results = Promise.allSettled([1, 2, 3].map((n) => unwrapper.unwrap(SLOT, envelope(n))));
    await settle();
    const [first, second, third] = await results;

    expect(first).toEqual({ status: 'fulfilled', value: keyOf(1) });
    expect(second!.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason.message).toContain('forbidden');
    expect(third).toEqual({ status: 'fulfilled', value: keyOf(3) });
    // One request served all three: the refusal cost no retry.
    expect(calls).toHaveLength(1);
  });

  it('drops a session that ended and opens a new one for the next message, once', async () => {
    const ended = fakeSession(() => new SessionEndedError('local-idle', 'Session idle; present again'));
    const fresh = fakeSession();
    const openSession = vi
      .fn<() => Promise<ChannelSession>>()
      .mockResolvedValueOnce(ended.session)
      .mockResolvedValueOnce(fresh.session);
    const unwrapper = createChannelUnwrapper({ openSession });

    // The message that finds the session ended fails: it is not sent again in a loop.
    const found = unwrapper.unwrap(SLOT, envelope(1));
    const outcome = expect(found).rejects.toBeInstanceOf(SessionEndedError);
    await settle();
    await outcome;
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(ended.calls).toHaveLength(1);
    expect(ended.session.stopped).toBe(1);

    // The next message opens exactly one new session, and later ones reuse it.
    const next = unwrapper.unwrap(SLOT, envelope(2));
    await settle();
    expect(await next).toEqual(keyOf(2));
    const later = unwrapper.unwrap(SLOT, envelope(3));
    await settle();
    expect(await later).toEqual(keyOf(3));

    expect(openSession).toHaveBeenCalledTimes(2);
    expect(ended.calls).toHaveLength(1);
    expect(fresh.calls.map((call) => call.numbers)).toEqual([[2], [3]]);
  });

  it('does not keep a failed opening: the next message asks again', async () => {
    const { session } = fakeSession();
    const openSession = vi
      .fn<() => Promise<ChannelSession>>()
      .mockRejectedValueOnce(new Error('the wallet refused'))
      .mockResolvedValueOnce(session);
    const unwrapper = createChannelUnwrapper({ openSession });

    const refusedPage = Promise.allSettled([1, 2].map((n) => unwrapper.unwrap(SLOT, envelope(n))));
    await settle();
    expect((await refusedPage).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(openSession).toHaveBeenCalledTimes(1);

    const next = unwrapper.unwrap(SLOT, envelope(3));
    await settle();
    expect(await next).toEqual(keyOf(3));
    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it('reports an exhausted channel balance (HTTP 402) without retrying, single or batched', async () => {
    const single = fakeSession(() => messageError(402));
    const openSession = vi.fn(async () => single.session);
    const unwrapper = createChannelUnwrapper({ openSession });

    const lone = unwrapper.unwrap(SLOT, envelope(1));
    const loneOutcome = lone.catch((error: unknown) => error);
    await settle();
    const loneError = await loneOutcome;
    expect(loneError).toBeInstanceOf(ChannelBalanceError);
    expect(isChannelBalanceError(loneError)).toBe(true);
    expect((loneError as Error).message).toMatch(/balance is exhausted/);
    expect(single.calls).toHaveLength(1);
    // The session is still good: a 402 is the slot's balance, not the grant.
    expect(openSession).toHaveBeenCalledTimes(1);

    const batched = fakeSession((n) => (n === 2 ? refused(402) : keyOf(n)));
    const batchUnwrapper = createChannelUnwrapper({ openSession: async () => batched.session });
    const page = Promise.allSettled([1, 2, 3].map((n) => batchUnwrapper.unwrap(SLOT, envelope(n))));
    await settle();
    const [first, second, third] = await page;
    expect(first!.status).toBe('fulfilled');
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(ChannelBalanceError);
    expect(third!.status).toBe('fulfilled');
    expect(batched.calls).toHaveLength(1);
  });

  it('passes any other keeper refusal through unchanged', async () => {
    const error = messageError(403);
    const { session } = fakeSession(() => error);
    const unwrapper = createChannelUnwrapper({ openSession: async () => session });

    const outcome = unwrapper.unwrap(SLOT, envelope(1)).catch((caught: unknown) => caught);
    await settle();
    expect(await outcome).toBe(error);
  });

  it('revokes every session on dispose, fails what is waiting and refuses later messages', async () => {
    const { session, calls } = fakeSession();
    const unwrapper = createChannelUnwrapper({ openSession: async () => session });

    const first = unwrapper.unwrap(SLOT, envelope(1));
    await settle();
    await first;

    const waiting = unwrapper.unwrap(SLOT, envelope(2));
    const waitingOutcome = expect(waiting).rejects.toThrow(/session has ended/);
    unwrapper.dispose();
    await waitingOutcome;
    await settle();

    expect(session.revoked).toBe(1);
    expect(calls).toHaveLength(1);
    await expect(unwrapper.unwrap(SLOT, envelope(3))).rejects.toThrow(/session has ended/);
  });

  it('revokes a session whose opening finishes after dispose', async () => {
    const { session, calls } = fakeSession();
    let release!: (opened: ChannelSession) => void;
    const unwrapper = createChannelUnwrapper({
      openSession: () => new Promise<ChannelSession>((resolve) => (release = resolve)),
    });

    const first = unwrapper.unwrap(SLOT, envelope(1));
    const outcome = expect(first).rejects.toThrow(/session has ended/);
    await settle();
    unwrapper.dispose();
    release(session);
    await outcome;

    expect(session.revoked).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
