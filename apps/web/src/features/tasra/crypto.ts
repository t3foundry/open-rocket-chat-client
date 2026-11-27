import { encryptEnvelope, fromBytes, hexToBytes, toBytes, type GroupEnvelope } from '@t3foundry/tasra-sdk';

import type { EncryptedRecord } from './detect';

/**
 * Recovers the AES data key wrapped in a validated envelope. In the app this is
 * the channel's decrypt session in `channel-unwrap.ts`; the caller of
 * {@link decryptMessage} supplies it so this module stays free of network,
 * storage and wallet concerns.
 */
export type UnwrapDataKey = (slotId: `0x${string}`, envelope: GroupEnvelope) => Promise<Uint8Array>;

/** What a decryption needs from the session. */
export interface DecryptOptions {
  unwrapDataKey: UnwrapDataKey;
}

/** The schema every record this module produces declares. */
export const SCHEMA = 'tasra-encrypt/v2';
/** Fixed title for a message record. */
const MESSAGE_TITLE = 'message';
/** Fixed title for a file record — the ciphertext is the uploaded file blob. */
export const FILE_TITLE = 'file';
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
 * Encrypts `fileBytes` under `slot` the same way {@link sealMessage} encrypts
 * text: AES-256-GCM under a fresh random data key, wrapped with the slot's
 * group public key. The ciphertext (IV + AES-GCM output) is returned as a raw
 * binary `Uint8Array` — the uploaded file — while the manifest and key envelope
 * travel separately as an {@link EncryptedRecord} JSON in the message text.
 *
 * The record's `aesCiphertext` is empty: the ciphertext lives in the blob.
 *
 * @param fileName Used only in the decryption UI; not part of the AEAD.
 */
export async function sealFile(
  fileBytes: Uint8Array<ArrayBuffer>,
  slot: { slotId: `0x${string}`; publicKey: `0x${string}`; epoch: number },
  recordId: string,
  version: number,
  deployment: { chainId: number; keyRegistry: string },
): Promise<{ encryptedBlob: Uint8Array; record: EncryptedRecord }> {
  const documentSha256 = toHex(await sha256(fileBytes));

  // Same AAD as messages: binds the record id into the AEAD.
  const aad = await sha256(new TextEncoder().encode(`${SCHEMA}:${recordId}`));

  const dataKey = new Uint8Array(DATA_KEY_LENGTH);
  crypto.getRandomValues(dataKey);

  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);

  const aesKey = await crypto.subtle.importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, fileBytes),
  );

  // IV + ciphertext as a self-contained binary blob.
  const encryptedBlob = new Uint8Array(iv.length + ciphertext.length);
  encryptedBlob.set(iv, 0);
  encryptedBlob.set(ciphertext, iv.length);

  // KEM identity is the document hash, exactly as for messages.
  const identity = new TextEncoder().encode(documentSha256);

  const envelope = encryptEnvelope(
    hexToBytes(slot.slotId),
    hexToBytes(slot.publicKey),
    identity,
    dataKey,
    BigInt(slot.epoch),
  );

  dataKey.fill(0);

  return {
    encryptedBlob,
    record: {
      manifest: {
        schema: SCHEMA,
        recordId,
        title: FILE_TITLE,
        version,
        documentSha256,
        chainId: deployment.chainId,
        keyRegistry: deployment.keyRegistry,
        slotId: slot.slotId,
      },
      envelope: {
        encryptedAesKey: b64(toBytes(envelope)),
        // The ciphertext is the uploaded file; the JSON carries only the key
        // material. An empty string tells the validator to skip the length
        // check (the blob is validated separately by the caller).
        aesCiphertext: '',
        epoch: slot.epoch,
      },
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
 *
 * @param options.skipAesCiphertext When `true`, the `aesCiphertext` length
 *   check is skipped so file records (whose ciphertext is the uploaded blob)
 *   can pass validation.
 */
export function validateEnvelope(
  record: EncryptedRecord,
  channelSlotId: `0x${string}`,
  options?: { skipAesCiphertext?: boolean },
): GroupEnvelope {
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

  if (!options?.skipAesCiphertext) {
    let aesBytes: Uint8Array;
    try {
      aesBytes = unb64(record.envelope.aesCiphertext);
    } catch {
      throw new Error('cannot decrypt: aesCiphertext is not valid base64');
    }
    if (aesBytes.length < MIN_AES_CIPHERTEXT_LENGTH) {
      throw new Error('cannot decrypt: aesCiphertext is too short');
    }
  }

  return envelope;
}

/**
 * Decrypts a `tasra-encrypt/v2` record into its original plaintext.
 *
 * The full multi-phase protocol: validates the envelope, obtains a reader
 * credential from the gateway, builds a committee-custody authorizer, unwraps
 * the data key via threshold BLS decrypt, AES-GCM decrypts the body, and
 * verifies the document hash.
 *
 * The caller is responsible for caching the result; this function performs no
 * caching of its own.
 *
 * @returns The plaintext message.
 */
export async function decryptMessage(
  tasraRecord: EncryptedRecord,
  tasraSlot: `0x${string}`,
  options: DecryptOptions,
): Promise<string> {
  const totalStart = performance.now();

  // Validate the envelope against the channel's slot.
  let stepStart = performance.now();
  const envelope = validateEnvelope(tasraRecord, tasraSlot);
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] envelope validation: ${(performance.now() - stepStart).toFixed(1)}ms`);

  // Unwrap the data key: the channel session's grant authorizes this message,
  // the keeper committee returns recipient-sealed shares, and only this client
  // opens and combines them.
  stepStart = performance.now();
  const dataKeyRaw = await options.unwrapDataKey(tasraSlot, envelope);
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] unwrap data key (session grant + keeper committee): ${(performance.now() - stepStart).toFixed(1)}ms`);

  // `dataKeyRaw` is Uint8Array<ArrayBufferLike>; copy to a plain
  // Uint8Array<ArrayBuffer> so WebCrypto accepts it as BufferSource.
  stepStart = performance.now();
  const dataKey = new Uint8Array(dataKeyRaw);
  dataKeyRaw.fill(0);
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] dataKey copy: ${(performance.now() - stepStart).toFixed(1)}ms`);

  try {
    // AES-GCM decrypt the message body.
    stepStart = performance.now();
    const aesCiphertext = unb64(tasraRecord.envelope.aesCiphertext);
    const iv = aesCiphertext.subarray(0, 12);
    const ciphertext = aesCiphertext.subarray(12) as BufferSource;

    const aad = await sha256(new TextEncoder().encode(`${SCHEMA}:${tasraRecord.manifest.recordId}`));
    const aesKey = await crypto.subtle.importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad },
        aesKey,
        ciphertext,
      ),
    );
// eslint-disable-next-line no-console
    console.log(`[tasra:timing] AES-GCM decrypt (sha256 aad + importKey + decrypt): ${(performance.now() - stepStart).toFixed(1)}ms`);

    // Verify the document hash.
    stepStart = performance.now();
    const computedHash = toHex(await sha256(plainBytes));
    if (computedHash !== tasraRecord.manifest.documentSha256) {
      throw new Error('document hash mismatch');
    }
// eslint-disable-next-line no-console
    console.log(`[tasra:timing] document hash verify (sha256 + hex): ${(performance.now() - stepStart).toFixed(1)}ms`);

    const text = new TextDecoder().decode(plainBytes);
// eslint-disable-next-line no-console
    console.log(`[tasra:timing] TOTAL decrypt: ${(performance.now() - totalStart).toFixed(1)}ms`);

    return text;
  } finally {
    // Per spec §9 step 6: zeroize the data key after use.
    dataKey.fill(0);
  }
}

/**
 * Decrypts an encrypted file blob produced by {@link sealFile}.
 *
 * The full multi-phase protocol is the same as {@link decryptMessage}: validate
 * the envelope, obtain a reader credential, unwrap the data key via threshold
 * BLS, AES-GCM decrypt the blob, and verify the document hash. The only
 * difference is that the ciphertext comes from the external `encryptedBlob`
 * parameter (the downloaded file) rather than from a base64 field in the JSON
 * record.
 *
 * @returns The original file bytes.
 */
export async function decryptFile(
  tasraRecord: EncryptedRecord,
  encryptedBlob: Uint8Array,
  tasraSlot: `0x${string}`,
  options: DecryptOptions,
): Promise<Uint8Array> {
  const totalStart = performance.now();

  // Validate the envelope against the channel's slot (skip aesCiphertext check).
  let stepStart = performance.now();
  const envelope = validateEnvelope(tasraRecord, tasraSlot, { skipAesCiphertext: true });
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] file envelope validation: ${(performance.now() - stepStart).toFixed(1)}ms`);

  // Guard: the blob must be at least IV + GCM tag.
  if (encryptedBlob.length < MIN_AES_CIPHERTEXT_LENGTH) {
    throw new Error('cannot decrypt: encrypted file is too short');
  }

  // Unwrap the data key through the channel session (see decryptMessage).
  stepStart = performance.now();
  const dataKeyRaw = await options.unwrapDataKey(tasraSlot, envelope);
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] file unwrap data key: ${(performance.now() - stepStart).toFixed(1)}ms`);

  stepStart = performance.now();
  const dataKey = new Uint8Array(dataKeyRaw);
  dataKeyRaw.fill(0);
// eslint-disable-next-line no-console
  console.log(`[tasra:timing] file dataKey copy: ${(performance.now() - stepStart).toFixed(1)}ms`);

  try {
    // AES-GCM decrypt the file blob.
    stepStart = performance.now();
    const iv = encryptedBlob.subarray(0, 12);
    const ciphertext = encryptedBlob.subarray(12) as BufferSource;

    const aad = await sha256(new TextEncoder().encode(`${SCHEMA}:${tasraRecord.manifest.recordId}`));
    const aesKey = await crypto.subtle.importKey('raw', dataKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad },
        aesKey,
        ciphertext,
      ),
    );
// eslint-disable-next-line no-console
    console.log(`[tasra:timing] file AES-GCM decrypt: ${(performance.now() - stepStart).toFixed(1)}ms`);

    // Verify the document hash.
    stepStart = performance.now();
    const computedHash = toHex(await sha256(plainBytes));
    if (computedHash !== tasraRecord.manifest.documentSha256) {
      throw new Error('document hash mismatch');
    }
// eslint-disable-next-line no-console
    console.log(`[tasra:timing] file document hash verify: ${(performance.now() - stepStart).toFixed(1)}ms`);

// eslint-disable-next-line no-console
    console.log(`[tasra:timing] TOTAL file decrypt: ${(performance.now() - totalStart).toFixed(1)}ms`);

    return plainBytes;
  } finally {
    dataKey.fill(0);
  }
}
