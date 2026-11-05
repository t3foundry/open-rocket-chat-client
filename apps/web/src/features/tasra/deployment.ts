import {
  resolveApplicationManifest,
  type ResolvedApplicationManifest,
  type TasraDeployment,
} from '@t3foundry/tasra-sdk/app';
import type { NetworkManifest } from '@t3foundry/tasra-sdk/chain';

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
  resolved ??= resolveApplicationManifest(rawNetwork as NetworkManifest, { coordinator: 'lowest-operator-id' });
  return resolved;
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
