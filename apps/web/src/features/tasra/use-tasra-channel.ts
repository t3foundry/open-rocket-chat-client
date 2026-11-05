import { useQuery } from '@tanstack/react-query';

import { useClient, useServerKeys } from '@/features/servers/server-scope';

import { parseTasraSlot } from './detect';

/**
 * The Tasra deployment the gateway fronts — `chainId`, `keyRegistry` — so
 * clients can confirm they are working with the right network.  Returned from
 * the gateway itself because the deployment's address is administrative
 * configuration, not something a client derives from scratch.
 */
export const useTasraDeployment = () => {
  const keys = useServerKeys();
  const c = useClient();

  return useQuery({
    queryKey: keys.tasraDeployment,
    queryFn: () => c.tasra.deployment(),
    staleTime: Infinity,
  });
};

/**
 * The BLS master public key and current epoch for a slot.
 *
 * The caller should inspect the error's `code` to distinguish a slot the
 * server has never heard of (`not_found`) from a deployment that doesn't
 * offer Tasra at all (`tasraNotConfigured`).
 */
export const useSlotPublicKey = (slotId: `0x${string}` | undefined) => {
  const keys = useServerKeys();
  const c = useClient();

  return useQuery({
    queryKey: keys.tasraSlotPublicKey(slotId as string),
    queryFn: () => c.tasra.publicKey(slotId!),
    enabled: Boolean(slotId),
  });
};

/**
 * The slot id a room's description declares, if it opens with `tasra:0x…`.
 *
 * A pure synchronous convenience — the underlying `parseTasraSlot` is covered
 * by its own unit tests, so this hook is straightforward.
 */
export const useTasraSlot = (room?: { description: string | null } | null): `0x${string}` | null =>
  parseTasraSlot(room?.description ?? null);
