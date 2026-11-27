import {
  resolveApplicationManifest,
  type ApplicationManifest,
  type ResolvedApplicationManifest,
  type TasraDeployment,
} from '@t3foundry/tasra-sdk/app';

import rawNetwork from './network.json';

/**
 * Memoised result of manifest resolution. Resolution is synchronous and cheap,
 * but it is deferred to first access: importing this module never resolves the
 * manifest, so a manifest that names no verifier-agent service only fails when
 * that URL is actually requested — not merely on module import.
 */
let resolved: ResolvedApplicationManifest | undefined;

/**
 * Resolves the checked-in network manifest into a validated deployment.
 *
 * This is the chain identity a `tasra-encrypt/v2` record names (`chainId` and
 * `keyRegistry`), plus the verifier-agent endpoint the SDK reads out of the
 * manifest's `services`. It does not construct a `TasraClient`.
 */
export function resolveTasraDeployment(): ResolvedApplicationManifest {
  if (!resolved) {
    const manifest = networkManifest();
    // A release manifest names no coordinator convention, so the build states it; an application
    // deployment document carries its own.
    resolved = resolveApplicationManifest(manifest, 'contracts' in manifest ? { coordinator: 'lowest-operator-id' } : {});
  }
  return resolved;
}

/**
 * The network this build talks to: the checked-in manifest, unless the build
 * names another one in `VITE_TASRA_NETWORK_MANIFEST` (the manifest JSON itself).
 * That is how a build is pointed at a local or private Tasra network.
 *
 * The override is either a release network manifest or an application
 * deployment document (`schemaVersion`, `name`, `chainId`, `rpcUrl`,
 * `addresses`, `coordinator`, and optionally `verifierAgentUrl` and
 * `keeperUrls`). The second form is how a local fleet maps each registered
 * keeper URL to one this browser can reach.
 */
function networkManifest(): ApplicationManifest {
  const override = (import.meta.env.VITE_TASRA_NETWORK_MANIFEST as string | undefined)?.trim();
  if (!override) return rawNetwork as ApplicationManifest;
  try {
    return JSON.parse(override) as ApplicationManifest;
  } catch {
    throw new Error('VITE_TASRA_NETWORK_MANIFEST is not valid JSON');
  }
}

/** The validated deployment, resolved lazily on first access. */
export function getDeployment(): Readonly<TasraDeployment> {
  return resolveTasraDeployment().deployment;
}

/**
 * The verifier-agent endpoint advertised by the network manifest, resolved
 * lazily so a manifest lacking the service does not throw on import.
 */
export function getVerifierAgentUrl(): string {
  const url = resolveTasraDeployment().verifierAgentUrl;
  if (!url) throw new Error('tasra network manifest advertises no verifier-agent service');
  return url;
}
