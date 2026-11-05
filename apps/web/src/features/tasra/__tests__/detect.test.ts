import { describe, expect, it } from 'vitest';

import { looksEncrypted, parseTasraSlot } from '../detect';

const slotId = `0x${'a1'.repeat(32)}`;

describe('parseTasraSlot', () => {
  it('reads the slot id from a message that opens with the header', () => {
    expect(parseTasraSlot(`tasra:${slotId} Incident room`)).toBe(slotId);
  });

  it('returns null when the header is not at the very start', () => {
    expect(parseTasraSlot(`Encrypted: tasra:${slotId}`)).toBeNull();
  });

  it('returns null for a missing or empty description', () => {
    expect(parseTasraSlot(null)).toBeNull();
    expect(parseTasraSlot(undefined)).toBeNull();
    expect(parseTasraSlot('')).toBeNull();
  });

  it('rejects a non-0x or wrong-length id', () => {
    expect(parseTasraSlot('tasra:hello world')).toBeNull();
    expect(parseTasraSlot(`tasra:${slotId.slice(0, -2)} room`)).toBeNull();
    expect(parseTasraSlot(`tasra:${slotId}extra room`)).toBeNull();
  });
});

describe('looksEncrypted', () => {
  it('recognizes a serialized tasra-encrypt/v2 record', () => {
    const record = JSON.stringify({ manifest: { schema: 'tasra-encrypt/v2' } });
    expect(looksEncrypted(record)).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(looksEncrypted(`  ${JSON.stringify({ manifest: { schema: 'tasra-encrypt/v2' } })}`)).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(looksEncrypted('hello world')).toBe(false);
  });

  it('returns false for a schema that is not the encrypted one', () => {
    expect(looksEncrypted(JSON.stringify({ manifest: { schema: 'something/else' } }))).toBe(false);
  });

  it('returns false for broken JSON', () => {
    expect(looksEncrypted('{ "manifest": { "schema": "tasra-encrypt/v2" ')).toBe(false);
  });
});
