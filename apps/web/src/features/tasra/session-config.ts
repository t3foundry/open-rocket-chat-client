import type { TasraIdentity } from '@t3foundry/tasra-sdk/app';
import { createBrowserAgentTransport, createIndexedDbStore } from '@t3foundry/tasra-sdk/app/browser';
import { parseApplicationServiceProfiles } from '@t3foundry/tasra-sdk/chain';
import type { TypedDataSigner } from '@t3foundry/tasra-sdk/oid4vp';

import { channelSessionOpener } from './channel-session';
import type { ChannelUnwrapDeps } from './channel-unwrap';
import { resolveTasraDeployment } from './deployment';
import { getTasraApplication } from './tasra-application';

/**
 * Browser wiring for a reader's decrypt sessions.
 *
 * Beyond the network description (the checked-in manifest, or
 * `VITE_TASRA_NETWORK_MANIFEST`), a build names one thing: the approved
 * verifier-agent profile (`VITE_TASRA_AGENT_PROFILE`). The SDK does not derive
 * that from the chain on purpose: an approval is the application's own reviewed
 * pin of the agent's registry identity, never a list downloaded from a registry.
 *
 * Keeper routing for a local fleet comes from the manifest itself (its
 * `keeperUrls`), so there is no separate route or plain-HTTP setting.
 */

const env = (name: string): string => ((import.meta.env[name] as string | undefined) ?? '').trim();

/** Local, disposable development chain: the only one where plain-HTTP keepers are allowed. */
const LOCAL_CHAIN_ID = 43112;

/**
 * The deployment's default verifier committee, for slots that name none on
 * chain: `VITE_TASRA_VERIFIER_POLICY` as `<committee>/<quorum>` (e.g. `3/2`).
 */
export function defaultVerificationPolicy(raw: string): { committee: number; quorum: number } | undefined {
  if (!raw) return undefined;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(raw);
  const committee = Number(match?.[1]);
  const quorum = Number(match?.[2]);
  if (!match || quorum > committee) {
    throw new Error('VITE_TASRA_VERIFIER_POLICY must be <committee>/<quorum>, e.g. 3/2');
  }
  return { committee, quorum };
}

/** The single verifier agent `profileText` (an application service-profiles document) approves for `chainId`. */
export function approvedAgentProfile(profileText: string, chainId: number) {
  if (!profileText) throw new Error('cannot decrypt: VITE_TASRA_AGENT_PROFILE is not set');
  const profiles = parseApplicationServiceProfiles(profileText);
  if (profiles.chainId !== chainId) {
    throw new Error('cannot decrypt: VITE_TASRA_AGENT_PROFILE approves an agent of another chain');
  }
  const profile = profiles.verifierAgents[0];
  if (!profile) throw new Error('cannot decrypt: VITE_TASRA_AGENT_PROFILE approves no verifier agent');
  return profile;
}

/** Everything {@link createChannelUnwrapper} needs, for this browser session. */
export function channelUnwrapDeps(options: {
  /** The reader's own signing key for this login session. Any key may open a session. */
  signer: TypedDataSigner;
  /** The session identity holding the holder key. */
  identity: TasraIdentity;
  getCredential: (slotId: string) => Promise<string>;
}): ChannelUnwrapDeps {
  const { deployment, keeperUrl } = resolveTasraDeployment();
  const profile = approvedAgentProfile(env('VITE_TASRA_AGENT_PROFILE'), deployment.chainId);
  const policy = defaultVerificationPolicy(env('VITE_TASRA_VERIFIER_POLICY'));
  const snapshotHosts = env('VITE_TASRA_SNAPSHOT_HOSTS')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  // The agent of a local fleet lives on a loopback or private host, which the transport
  // refuses unless the application approves that exact host.
  const local = deployment.chainId === LOCAL_CHAIN_ID;

  return {
    openSession: channelSessionOpener({
      app: getTasraApplication(),
      agent: {
        profile,
        transport: createBrowserAgentTransport(
          local ? { allowedPrivateHosts: [new URL(profile.endpoint).hostname] } : {},
        ),
      },
      // One store per deployment: the session journal must survive reloads and is shared across tabs.
      store: createIndexedDbStore({ name: `orc-tasra-sessions-${deployment.chainId}` }),
      signer: options.signer,
      identity: options.identity,
      getCredential: options.getCredential,
      ...(keeperUrl ? { keeperUrl } : {}),
      ...(local ? { allowLocalHttp: true } : {}),
      ...(policy ? { defaultVerificationPolicy: policy } : {}),
      ...(snapshotHosts.length > 0 ? { snapshotHosts } : {}),
    }),
    onTiming: (phase, elapsed) => {
      // eslint-disable-next-line no-console
      console.log(`[tasra:timing]   └ ${phase}: ${elapsed.toFixed(1)}ms`);
    },
  };
}
