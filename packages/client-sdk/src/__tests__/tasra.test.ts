import { describe, expect, it, vi } from 'vitest';

import { OpenRocketChatClient } from '../client.js';

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const client = (fetch: typeof globalThis.fetch): OpenRocketChatClient =>
  new OpenRocketChatClient({ baseUrl: 'https://gateway.test', fetch });

describe('OpenRocketChatClient.tasra', () => {
  it('fetches the deployment the manifest has to name', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ chainId: 43113, keyRegistry: '0x45F432aB5709e9920b5ec349D29663D7200A8C39' }));

    await expect(client(fetch).tasra.deployment()).resolves.toEqual({
      chainId: 43113,
      keyRegistry: '0x45F432aB5709e9920b5ec349D29663D7200A8C39',
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://gateway.test/api/v1/tasra/deployment');
    expect(init?.method).toBe('GET');
  });

  it('asks for a slot public key by its slot id', async () => {
    const slotId = `0x${'ab'.repeat(32)}`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ publicKey: '0x', epoch: 0 }));

    await expect(client(fetch).tasra.publicKey(slotId)).resolves.toEqual({ publicKey: '0x', epoch: 0 });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://gateway.test/api/v1/tasra/public-key?slotId=${slotId}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('mints a document-reader credential with the slot and did as the body', async () => {
    const input = { slotId: `0x${'cd'.repeat(32)}`, did: 'did:jwk:eyJrdHkiOiJFQyJ9' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        credential: 'issuer~a~b',
        issuer: 'did:web:issuer.test',
        vct: 'DocumentReader',
        expiresAt: '2030-01-01T00:00:00Z',
      }),
    );

    await expect(client(fetch).tasra.issueDocumentReader(input)).resolves.toEqual({
      credential: 'issuer~a~b',
      issuer: 'did:web:issuer.test',
      vct: 'DocumentReader',
      expiresAt: '2030-01-01T00:00:00Z',
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://gateway.test/api/v1/tasra/credentials/document-reader');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });
});
