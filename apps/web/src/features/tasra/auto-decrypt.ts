import type { Message } from '@open-rocket-chat/client-sdk';
import { useEffect, useRef } from 'react';

import { isChannelBalanceError, MAX_BATCH } from './channel-unwrap';
import { decryptMessage } from './crypto';
import { decryptedCache } from './decrypt-cache';
import { decryptFailures } from './decrypt-failures';
import { looksEncrypted, type EncryptedRecord } from './detect';
import { Semaphore } from './semaphore';
import type { TasraSessionValue } from './tasra-provider';

/**
 * Max messages being decrypted at once: one full keeper batch.
 *
 * The channel unwrapper collects the data keys of messages that arrive together
 * and sends them as ONE request per keeper, so the bound that protects the
 * keepers is the batch, not the message. A lower limit here would cut a page of
 * history into that many requests.
 */
const MAX_PARALLEL_DECRYPT = MAX_BATCH;

/**
 * Parses a message body into an `EncryptedRecord` or returns `null` if the
 * message is not a `tasra-encrypt/v2` record.
 */
const parseRecord = (message: Message): EncryptedRecord | null => {
  if (!looksEncrypted(message.text)) return null;
  try {
    return JSON.parse(message.text) as EncryptedRecord;
  } catch {
    return null;
  }
};

/**
 * Auto-decrypts Tasra-encrypted messages as they arrive.
 *
 * Keeps a pool of at most {@link MAX_PARALLEL_DECRYPT} concurrent decryptions,
 * which the channel session sends as one keeper batch, so a room load that
 * unpacks many messages at once costs a few requests. Results are persisted to
 * IndexedDB via {@link decryptedCache} so subsequent visits skip decryption
 * entirely. A failure is recorded in {@link decryptFailures} so the timeline
 * can show it: a message is retried automatically at most once, and never
 * when the channel's balance is exhausted.
 *
 * Call once per timeline, passing the messages array and the room's slot +
 * session. The hook is a passive observer — it does not return anything and
 * never throws.
 */
export const useAutoDecryptTasra = (
  messages: Message[],
  tasraSlot: `0x${string}` | null,
  tasraSession: TasraSessionValue | null,
): void => {
  const semaphore = useRef(new Semaphore(MAX_PARALLEL_DECRYPT));
  const inflight = useRef(new Set<string>());

  // Reset in-flight tracking when the slot changes (different room).
  const prevSlot = useRef(tasraSlot);
  if (prevSlot.current !== tasraSlot) {
    prevSlot.current = tasraSlot;
    inflight.current.clear();
  }

  useEffect(() => {
    if (!tasraSlot || !tasraSession) return;

    // Messages are derived from the infinite-query select, so they are a new
    // array reference on every cache change. Filter to what needs decrypting.
    const candidates = messages.filter((message) => {
      const record = parseRecord(message);
      if (!record) return false;

      const recordId = record.manifest.recordId;

      // Already decrypted (in memory or persisted).
      const cached = decryptedCache.get(recordId);
      if (cached && cached.version >= record.manifest.version) return false;

      // Already being decrypted.
      if (inflight.current.has(recordId)) return false;

      // Failed before, and not to be sent again without the user asking.
      if (!decryptFailures.mayRetry(recordId)) return false;

      return true;
    });

    // Fire off decryptions — each one acquires a semaphore permit internally.
    for (const message of candidates) {
      const record = parseRecord(message);
      if (!record) continue;

      const recordId = record.manifest.recordId;
      inflight.current.add(recordId);

      // Intentionally not awaited: each decryption runs independently.
      void semaphore.current
        .run(() =>
          decryptMessage(record!, tasraSlot, { unwrapDataKey: tasraSession.unwrapDataKey }),
        )
        .then((text) => {
          decryptedCache.set(recordId, {
            text,
            version: record!.manifest.version,
          });
          decryptFailures.remove(recordId);
        })
        .catch((error: unknown) => {
          console.error('[tasra:auto] decrypt failed for', recordId, error);
          decryptFailures.record(recordId, {
            message: error instanceof Error ? error.message : 'Unknown error',
            balance: isChannelBalanceError(error),
          });
        })
        .finally(() => {
          inflight.current.delete(recordId);
        });
    }
  }, [messages, tasraSlot, tasraSession]);
};