import { encryptEnvelope, fromBytes, hexToBytes, toBytes, type GroupEnvelope } from '@t3foundry/tasra-sdk';

import type { EncryptedRecord } from './detect';

/** The schema every record this module produces declares. */
export const SCHEMA = 'tasra-encrypt/v2';
/** Fixed title for a message record. */
const MESSAGE_TITLE = 'message';
/** AES-256 data key length. */
export const DATA_KEY_LENGTH = 32;
/** AES-GCM IV length. */
export const IV_LENGTH = 12;
/** The shortest valid `aesCiphertext`: 12-byte IV + 16-byte GCM tag. */
export const MIN_AES_CIPHERTEXT_LENGTH = IV_LENGTH + 16;
/** Bytes per `String.fromCharCode` call, matching the SDK's own chunked encoder. */
const BASE64_CHUNK = 0x8000;

/**
 * SHA-256 of `bytes` as raw bytes, through WebCrypto.
 *
 * The result is `Uint8Array<ArrayBuffer>` — a fresh buffer — so it satisfies
 * the `BufferSource` that `crypto.subtle` demands elsewhere, unlike a plain
 * `Uint8Array` view (which may sit over a `SharedArrayBuffer`).
 */
export async function sha256(bytes: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Lowercase hex of `bytes`, no `0x` prefix. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Standard (padded, `+/`/`=`) base64 of `bytes`.
 *
 * Encodes in ≤ `BASE64_CHUNK`-byte slices. Spreading every byte as a separate
 * `String.fromCharCode` argument overflows the call stack once the input
 * passes ~124 KiB, so large ciphertexts must be chunked. Output is identical
 * to the naive single-call form for small inputs.
 */
export function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** Inverse of {@link b64}. */
export function unb64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/**
 * Encrypts `text` into a `tasra-encrypt/v2` record under `slot`.
 *
 * The plaintext is AES-256-GCM-encrypted under a fresh random data key with a
 * random IV prefixed to the ciphertext. That data key is then wrapped with the
 * slot's group public key via {@link encryptEnvelope}, so only holders of the
 * slot's threshold key can ever recover it. The AES AAD binds the record id
 * into the ciphertext, and the KEM identity binds the document hash into the
 * key wrap.
 *
 * @param recordId A UUID identifying this record, generated with
 *   `crypto.randomUUID()`. It must be a UUID — not a `clientMessageId`, which
 *   is 17 characters long.
 */
export async function sealMessage(
  text: string,
  slot: { slotId: `0x${string}`; publicKey: `0x${string}`; epoch: number },
  recordId: string,
  version: number,
  deployment: { chainId: number; keyRegistry: string },
): Promise<EncryptedRecord> {
  const plaintext = new TextEncoder().encode(text);
  const documentSha256 = toHex(await sha256(plaintext));

  // AES-GCM AAD = SHA-256("tasra-encrypt/v2:" + recordId). Binding the record
  // id into the AEAD means the same plaintext under a different record still
  // fails to authenticate.
  const aad = await sha256(new TextEncoder().encode(`${SCHEMA}:${recordId}`));

  const dataKey = new Uint8Array(DATA_KEY_LENGTH);
  crypto.getRandomValues(dataKey);

  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const aesKey = await crypto.subtle.importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plaintext),
  );

  // The IV is not secret; prefixing it keeps the ciphertext self-contained.
  const aesCiphertext = new Uint8Array(iv.length + ciphertext.length);
  aesCiphertext.set(iv, 0);
  aesCiphertext.set(ciphertext, iv.length);

  // KEM identity is the document hash as ASCII — the same 64 lowercase hex
  // characters the manifest records.
  const identity = new TextEncoder().encode(documentSha256);

  const envelope = encryptEnvelope(
    hexToBytes(slot.slotId),
    hexToBytes(slot.publicKey),
    identity,
    dataKey,
    BigInt(slot.epoch),
  );

  // The data key is now wrapped inside the envelope; scrub the plain copy.
  dataKey.fill(0);

  return {
    manifest: {
      schema: SCHEMA,
      recordId,
      title: MESSAGE_TITLE,
      version,
      documentSha256,
      chainId: deployment.chainId,
      keyRegistry: deployment.keyRegistry,
      slotId: slot.slotId,
    },
    envelope: {
      encryptedAesKey: b64(toBytes(envelope)),
      aesCiphertext: b64(aesCiphertext),
      epoch: slot.epoch,
    },
  };
}

/**
 * Parses a record's key envelope and checks the invariants that let a reader
 * trust it enough to hand to the threshold decryption layer.
 *
 * Every failure is a "cannot decrypt" case, so each throws a descriptive
 * `Error` rather than a boolean. The parsed {@link GroupEnvelope} is returned
 * for the caller to decrypt with the slot's assembled master key.
 */
export function validateEnvelope(record: EncryptedRecord, channelSlotId: `0x${string}`): GroupEnvelope {
  if (record.manifest.schema !== SCHEMA) {
    throw new Error('cannot decrypt: manifest schema is not tasra-encrypt/v2');
  }

  if (record.manifest.slotId.toLowerCase() !== channelSlotId.toLowerCase()) {
    throw new Error('cannot decrypt: manifest slotId does not match the channel');
  }

  let envelope: GroupEnvelope;
  try {
    envelope = fromBytes(unb64(record.envelope.encryptedAesKey));
  } catch {
    throw new Error('cannot decrypt: encryptedAesKey is not a valid envelope');
  }

  // A v0x01 envelope carries no epoch. Reject it up front with a precise
  // message rather than letting it fall through to a misleading "epoch
  // mismatch" against the manifest's number.
  if (envelope.epoch === null) {
    throw new Error('Envelope version mismatch (expected v0x02)');
  }

  if (toHex(envelope.slotId).toLowerCase() !== record.manifest.slotId.slice(2).toLowerCase()) {
    throw new Error('cannot decrypt: envelope slotId does not match the manifest');
  }

  if (!Number.isInteger(record.envelope.epoch)) {
    throw new Error('Invalid envelope epoch');
  }
  if (envelope.epoch !== BigInt(record.envelope.epoch)) {
    throw new Error('cannot decrypt: envelope epoch does not match the manifest');
  }

  if (new TextDecoder().decode(envelope.identity) !== record.manifest.documentSha256) {
    throw new Error('cannot decrypt: envelope identity does not match the document hash');
  }

  let aesBytes: Uint8Array;
  try {
    aesBytes = unb64(record.envelope.aesCiphertext);
  } catch {
    throw new Error('cannot decrypt: aesCiphertext is not valid base64');
  }
  if (aesBytes.length < MIN_AES_CIPHERTEXT_LENGTH) {
    throw new Error('cannot decrypt: aesCiphertext is too short');
  }

  return envelope;
}
