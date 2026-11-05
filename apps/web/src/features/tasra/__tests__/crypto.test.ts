import { encryptEnvelope, fromBytes, hexToBytes, toBytes } from '@t3foundry/tasra-sdk';
import { describe, expect, it } from 'vitest';

import { b64, sealMessage, sha256, toHex, unb64, validateEnvelope } from '../crypto';

// A valid compressed BLS12-381 G2 point (the group generator) stands in for
// the slot's master public key. `encryptEnvelope` only needs the public key
// and parses it as a curve point, so a random 96-byte value would not do.
const PUBLIC_KEY = `0x93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049
334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051
c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8`.replace(/\s/g, '');

const slot = {
  slotId: `0x${'b7'.repeat(32)}` as `0x${string}`,
  publicKey: PUBLIC_KEY as `0x${string}`,
  epoch: 0,
};

const deployment = { chainId: 43113, keyRegistry: '0x45F432aB5709e9920b5ec349D29663D7200A8C39' };

describe('sealMessage / validateEnvelope', () => {
  it('seals a record that validates against its own slot', async () => {
    const text = 'attack at dawn';
    const record = await sealMessage(text, slot, 'record-1', 1, deployment);

    // The manifest names the slot it was sealed under and the hash of the
    // encoded plaintext.
    expect(record.manifest.slotId).toBe(slot.slotId);
    expect(record.manifest.documentSha256).toBe(toHex(await sha256(new TextEncoder().encode(text))));
    expect(record.manifest.schema).toBe('tasra-encrypt/v2');
    expect(record.manifest.title).toBe('message');
    expect(record.manifest.chainId).toBe(deployment.chainId);
    expect(record.manifest.keyRegistry).toBe(deployment.keyRegistry);
    expect(record.envelope.epoch).toBe(0);

    // The key envelope serializes as v0x02 (epoch present).
    const envelopeBytes = unb64(record.envelope.encryptedAesKey);
    expect(envelopeBytes[0]).toBe(0x02);

    // `fromBytes` parses it back with the epoch we sealed under.
    const reparsed = fromBytes(envelopeBytes);
    expect(reparsed.epoch).toBe(0n);
    expect(toHex(reparsed.slotId)).toBe(slot.slotId.slice(2));

    // The full invariant set passes for the channel the record was sealed for.
    expect(() => validateEnvelope(record, slot.slotId)).not.toThrow();
    expect(validateEnvelope(record, slot.slotId).epoch).toBe(0n);
  });

  it('rejects a record presented for a different channel slot', async () => {
    const record = await sealMessage('secret', slot, 'record-2', 1, deployment);
    const otherSlot = `0x${'c1'.repeat(32)}` as `0x${string}`;

    expect(() => validateEnvelope(record, otherSlot)).toThrow(/slotId does not match the channel/);
  });

  it('rejects a record whose aesCiphertext is too short', async () => {
    const record = await sealMessage('secret', slot, 'record-3', 1, deployment);
    const truncated = {
      ...record,
      envelope: { ...record.envelope, aesCiphertext: b64(new Uint8Array(27)) },
    };

    expect(() => validateEnvelope(truncated, slot.slotId)).toThrow(/aesCiphertext is too short/);
  });

  it('rejects a record whose manifest schema is unknown', async () => {
    const record = await sealMessage('secret', slot, 'record-4', 1, deployment);
    const tampered = { ...record, manifest: { ...record.manifest, schema: 'tasra-encrypt/v1' } };

    expect(() => validateEnvelope(tampered, slot.slotId)).toThrow(/manifest schema is not tasra-encrypt\/v2/);
  });

  it('rejects a record whose envelope was sealed for a different slot', async () => {
    const record = await sealMessage('secret', slot, 'record-5', 1, deployment);
    const otherSlot = { ...slot, slotId: `0x${'c1'.repeat(32)}` as `0x${string}` };
    const otherEnvelope = (await sealMessage('secret', otherSlot, 'record-5', 1, deployment)).envelope;
    const tampered = { ...record, envelope: { ...record.envelope, encryptedAesKey: otherEnvelope.encryptedAesKey } };

    expect(() => validateEnvelope(tampered, slot.slotId)).toThrow(/envelope slotId does not match the manifest/);
  });

  it('rejects a record whose envelope epoch disagrees with the manifest', async () => {
    const record = await sealMessage('secret', slot, 'record-6', 1, deployment);
    const tampered = { ...record, envelope: { ...record.envelope, epoch: record.envelope.epoch + 1 } };

    expect(() => validateEnvelope(tampered, slot.slotId)).toThrow(/epoch does not match the manifest/);
  });

  it('rejects a record whose document hash disagrees with the envelope identity', async () => {
    const record = await sealMessage('secret', slot, 'record-7', 1, deployment);
    const hash = record.manifest.documentSha256;
    const flipped = hash[0] === '0' ? '1' : '0';
    const tampered = {
      ...record,
      manifest: { ...record.manifest, documentSha256: flipped + hash.slice(1) },
    };

    expect(() => validateEnvelope(tampered, slot.slotId)).toThrow(/identity does not match the document hash/);
  });

  it('rejects a legacy v0x01 envelope with a version mismatch', async () => {
    // A v0x01 envelope carries no epoch; `encryptEnvelope(..., null)` emits one.
    const legacy = encryptEnvelope(
      hexToBytes(slot.slotId),
      hexToBytes(slot.publicKey),
      new TextEncoder().encode('a'.repeat(64)),
      new Uint8Array(32),
      null,
    );
    const record = {
      manifest: {
        schema: 'tasra-encrypt/v2',
        recordId: 'record-8',
        title: 'message',
        version: 1,
        documentSha256: 'a'.repeat(64),
        chainId: deployment.chainId,
        keyRegistry: deployment.keyRegistry,
        slotId: slot.slotId,
      },
      envelope: {
        encryptedAesKey: b64(toBytes(legacy)),
        aesCiphertext: b64(new Uint8Array(28)),
        epoch: 0,
      },
    };

    expect(() => validateEnvelope(record, slot.slotId)).toThrow(/Envelope version mismatch/);
  });

  it('rejects a record whose envelope epoch is not an integer', async () => {
    const record = await sealMessage('secret', slot, 'record-9', 1, deployment);
    const tampered = { ...record, envelope: { ...record.envelope, epoch: 1.5 } };

    expect(() => validateEnvelope(tampered, slot.slotId)).toThrow(/Invalid envelope epoch/);
  });
});
