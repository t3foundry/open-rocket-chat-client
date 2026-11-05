import { describe, expect, it, vi } from 'vitest';

import { createCredentialCache } from '../credential-cache';

describe('createCredentialCache', () => {
  it('calls the issuer once and returns the same promise for repeated gets', async () => {
    const issue = vi.fn<(slotId: string) => Promise<string>>().mockResolvedValue('cred-a');
    const cache = createCredentialCache(issue);

    const p1 = cache.get('slot-a');
    const p2 = cache.get('slot-a');

    expect(p1).toBe(p2);
    expect(issue).toHaveBeenCalledTimes(1);

    await expect(p1).resolves.toBe('cred-a');
  });

  it('evicts on failure so a retry calls the issuer again', async () => {
    let callCount = 0;
    const issue = vi.fn<(slotId: string) => Promise<string>>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return 'cred-b';
    });
    const cache = createCredentialCache(issue);

    const p1 = cache.get('slot-b');
    await expect(p1).rejects.toThrow('boom');

    // After the failure, the next call should trigger a fresh `issue`.
    const p2 = cache.get('slot-b');
    await expect(p2).resolves.toBe('cred-b');
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('keeps successes independent across slots', async () => {
    const issue = vi.fn<(slotId: string) => Promise<string>>().mockImplementation(async (slotId) => `${slotId}-cred`);
    const cache = createCredentialCache(issue);

    const a = await cache.get('slot-a');
    const b = await cache.get('slot-b');

    expect(a).toBe('slot-a-cred');
    expect(b).toBe('slot-b-cred');
    expect(issue).toHaveBeenCalledTimes(2);
  });
});
