/**
 * The `tasra-encrypt/v2` record shape, as a client writes and reads it.
 *
 * This is the wire document the gateway stores as an encrypted message: a
 * `manifest` describing what the blob is, and an `envelope` carrying the
 * wrapped content key and the AES-GCM ciphertext.
 */
export interface EncryptedRecord {
  manifest: {
    schema: string;
    recordId: string;
    title: string;
    version: number;
    documentSha256: string;
    chainId: number;
    keyRegistry: string;
    slotId: `0x${string}`;
  };
  envelope: {
    encryptedAesKey: string;
    aesCiphertext: string;
    epoch: number;
  };
}

/**
 * Matches a valid slot id: `0x` followed by exactly 64 hex characters.
 *
 * Reusable for input validation in room create/edit forms and wherever a slot
 * id must be validated before being accepted.
 */
export const TASRA_SLOT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Matches a slot reference at the very start of a message: `tasra:` then a
 * full `0x` + 64 hex digits, followed by whitespace or the end of the string.
 *
 * Anchored at the start on purpose — `Encrypted: tasra:0x…` is prose about a
 * slot, not the slot header, and must not be read as one.
 */
const TASRA_SLOT_REGEX = /^tasra:(0x[0-9a-fA-F]{64})(?=\s|$)/;

/**
 * Extracts the slot id a message declares itself bound to, if the text opens
 * with the `tasra:0x…` header. Returns the id as it appears in the string.
 */
export function parseTasraSlot(description: string | null | undefined): `0x${string}` | null {
  if (description == null) return null;

  const match = TASRA_SLOT_REGEX.exec(description);
  return (match?.[1] as `0x${string}` | undefined) ?? null;
}

/**
 * Whether `text` is a serialized `tasra-encrypt/v2` record.
 *
 * Cheap, JSON-shape-only: the body must open with `{` (a trim of leading
 * whitespace is tolerated) and its `manifest.schema` must be the encrypted
 * schema. Malformed JSON is simply "not encrypted".
 */
export function looksEncrypted(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false;

  try {
    const parsed: unknown = JSON.parse(text);
    const manifest = (parsed as { manifest?: { schema?: unknown } } | null)?.manifest;
    return manifest?.schema === 'tasra-encrypt/v2';
  } catch {
    return false;
  }
}
