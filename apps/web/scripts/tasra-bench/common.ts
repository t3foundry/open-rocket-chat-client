// Shared setup for the Tasra reader bench (Node). Everything comes from the environment, so the same
// harness runs against any deployment; nothing here is specific to one fleet.
//
// A reader holds nothing of the slot's owner: no creator key, no gas, no rule and no rule salt.
//
// The network, one of:
//   MANIFEST_FILE            a release network manifest, or an application deployment document
//                            (schemaVersion, name, chainId, rpcUrl, addresses, coordinator, keeperUrls)
//   RPC_URL + KEY_REGISTRY + NODE_REGISTRY + SERVICE_REGISTRY + VERIFIER_SET_REGISTRY + THRESHOLD_BEACON
//                            (+ CHAIN_ID, default 43112)
// Required:
//   AGENT_PROFILE            file: the approved verifier-agent service-profiles document
//   SLOT_ID                  the channel's BLS slot
//   SD_JWT_FILE              file: the reader credential (SD-JWT VC)
//   HOLDER_KEY_FILE          file: the credential's holder key, a base64url Ed25519 seed
//   STORE_DIR                a private directory for the session journal
// Optional:
//   AGENT_CA_FILE            file: CA certificate of a private verifier agent
//   KEEPER_ROUTES            file: JSON map, registered keeper URL -> a URL this process can reach
//   VERIFIER_POLICY          <committee>/<quorum>, for a slot that names no policy on chain
//   SNAPSHOT_HOSTS           comma-separated origins serving the verifier-set snapshot artifacts
//                            (default: the registered accountants, read from the chain)
//   SIGNER_KEY               the reader's signing key (default: a fresh random key; any key may open a session)
import fs from 'node:fs';

import {
  createLocalWallet,
  createTasra,
  resolveApplicationManifest,
  type ApplicationManifest,
} from '@t3foundry/tasra-sdk/app';
import { createFileStore } from '@t3foundry/tasra-sdk/app/node';
import { parseApplicationServiceProfiles } from '@t3foundry/tasra-sdk/chain';
import { createNodeAgentTransport, createNodeAgentWalletFetch } from '@t3foundry/tasra-sdk/chain/node';
import { b64urlDecode, ed25519HolderKey } from '@t3foundry/tasra-sdk/oid4vp';

import { channelSessionOpener } from '../../src/features/tasra/channel-session.ts';
import type { ChannelUnwrapDeps } from '../../src/features/tasra/channel-unwrap.ts';

type Hex = `0x${string}`;

const optional = (key: string): string | undefined => process.env[key]?.trim() || undefined;
const env = (key: string): string => {
  const value = optional(key);
  if (!value) throw new Error(`set ${key}`);
  return value;
};
const file = (key: string): string => fs.readFileSync(env(key), 'utf8').trim();

/** The network description: a manifest file, or the RPC URL and the addresses a session reads. */
function manifest(): ApplicationManifest {
  if (optional('MANIFEST_FILE')) return JSON.parse(file('MANIFEST_FILE')) as ApplicationManifest;
  return {
    schemaVersion: 1,
    name: 'tasra-bench',
    chainId: Number(optional('CHAIN_ID') ?? 43112),
    rpcUrl: env('RPC_URL'),
    coordinator: 'assigned-first',
    addresses: {
      KeyRegistry: env('KEY_REGISTRY') as Hex,
      NodeRegistry: env('NODE_REGISTRY') as Hex,
      ServiceRegistry: env('SERVICE_REGISTRY') as Hex,
      VerifierSetRegistry: env('VERIFIER_SET_REGISTRY') as Hex,
      ThresholdRandomBeacon: env('THRESHOLD_BEACON') as Hex,
    },
  };
}

const described = manifest();
const resolved = resolveApplicationManifest(described, 'contracts' in described ? { coordinator: 'lowest-operator-id' } : {});
export const deployment = resolved.deployment;
export const chainId = deployment.chainId;
export const slot = env('SLOT_ID') as Hex;

const routes: Record<string, string> = optional('KEEPER_ROUTES') ? JSON.parse(file('KEEPER_ROUTES')) : {};
/** Registered keeper URL -> a URL this process can reach: KEEPER_ROUTES first, then the manifest's `keeperUrls`. */
export const keeperUrl = (url: string): string => routes[url.replace(/\/$/, '')] ?? resolved.keeperUrl?.(url) ?? url;

export const app = createTasra({ deployment, keeperUrl });

const profile = (() => {
  const approved = parseApplicationServiceProfiles(file('AGENT_PROFILE')).verifierAgents[0];
  if (!approved) throw new Error('AGENT_PROFILE approves no verifier agent');
  return approved;
})();
const agentPolicy = {
  ...(optional('AGENT_CA_FILE') ? { ca: file('AGENT_CA_FILE') } : {}),
  allowedPrivateHosts: [new URL(profile.endpoint).hostname],
};

const policy = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(optional('VERIFIER_POLICY') ?? '');
if (optional('VERIFIER_POLICY') && !policy) throw new Error('VERIFIER_POLICY must be <committee>/<quorum>, e.g. 3/2');
const snapshotHosts = (optional('SNAPSHOT_HOSTS') ?? '').split(',').map((url) => url.trim()).filter(Boolean);

const credential = file('SD_JWT_FILE');
const holder = ed25519HolderKey(b64urlDecode(file('HOLDER_KEY_FILE')));
// The reader's own signing key. Any key may open a session: the slot's rule decides.
const signer = createLocalWallet(deployment, optional('SIGNER_KEY') ? { privateKey: env('SIGNER_KEY') as Hex } : {}).signer;

/**
 * What `createChannelUnwrapper` needs, wired for Node: the app's own session opener over a file
 * store, the Node agent transport (with the agent's CA) and the reader credential from disk.
 */
export function channelUnwrapDeps(onTiming?: ChannelUnwrapDeps['onTiming']): ChannelUnwrapDeps {
  return {
    openSession: channelSessionOpener({
      app,
      agent: { profile, transport: createNodeAgentTransport(agentPolicy) },
      store: createFileStore(env('STORE_DIR')),
      signer,
      identity: { holder },
      getCredential: async () => credential,
      // Wallet traffic stays on the approved session: its request URI, response URI and the agent DID.
      walletFetch: (session) => createNodeAgentWalletFetch(session, agentPolicy),
      keeperUrl,
      ...(chainId === 43112 ? { allowLocalHttp: true } : {}),
      ...(policy ? { defaultVerificationPolicy: { committee: Number(policy[1]), quorum: Number(policy[2]) } } : {}),
      ...(snapshotHosts.length > 0 ? { snapshotHosts } : {}),
    }),
    ...(onTiming ? { onTiming } : {}),
  };
}

/** What the gateway's `tasra/public-key` endpoint serves: the slot's group key and epoch, read from the chain. */
export async function publicSlot(): Promise<{ slotId: Hex; publicKey: Hex; epoch: number }> {
  const record = await app.chain.readers.keyRegistry.getKeySlot(slot);
  if (!record.exists) throw new Error(`slot ${slot} does not exist on chain ${chainId}`);
  return { slotId: slot, publicKey: record.publicKey as Hex, epoch: Number(record.epoch) };
}

export const ms = (from: number): number => Math.round((performance.now() - from) * 10) / 10;

export function summarize(label: string, samples: number[]): void {
  if (!samples.length) return;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  console.log(
    `${label.padEnd(34)} n=${sorted.length}  min ${sorted[0]!.toFixed(0)}  p50 ${at(0.5).toFixed(0)}  ` +
      `mean ${mean.toFixed(0)}  p95 ${at(0.95).toFixed(0)}  max ${sorted[sorted.length - 1]!.toFixed(0)}  (ms)`,
  );
}
