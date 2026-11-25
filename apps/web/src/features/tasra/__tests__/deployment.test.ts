import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import rawNetwork from '../network.json';

/**
 * The deployment is resolved once and memoised, from a build-time variable.
 * Each test sets the variable and loads the module fresh, so a developer's
 * `.env.local` (which may point the build at a local fleet) cannot decide the
 * outcome.
 */
const loadDeployment = async (manifest = '') => {
  vi.stubEnv('VITE_TASRA_NETWORK_MANIFEST', manifest);
  vi.resetModules();
  return import('../deployment');
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveTasraDeployment', () => {
  it('resolves the checked-in manifest to the chain it names', async () => {
    const { resolveTasraDeployment } = await loadDeployment();
    expect(resolveTasraDeployment().deployment.chainId).toBe(rawNetwork.chainId);
  });
});

describe('getDeployment', () => {
  it('names the KeyRegistry contract from the manifest', async () => {
    const { getDeployment } = await loadDeployment();
    expect(getDeployment().addresses.KeyRegistry?.toLowerCase()).toBe('0x45f432ab5709e9920b5ec349d29663d7200a8c39');
  });

  it('points at an https RPC endpoint', async () => {
    const { getDeployment } = await loadDeployment();
    expect(getDeployment().rpcUrl).toMatch(/^https:\/\//);
  });

  it('carries the chain id the manifest declares', async () => {
    const { getDeployment } = await loadDeployment();
    expect(getDeployment().chainId).toBe(rawNetwork.chainId);
  });
});

describe('getVerifierAgentUrl', () => {
  it('is the verifier-agent service the manifest advertises', async () => {
    const { getVerifierAgentUrl } = await loadDeployment();
    expect(getVerifierAgentUrl()).toBe('https://agent.t3-foundry.fuji.tasra.network');
  });
});

describe('VITE_TASRA_NETWORK_MANIFEST', () => {
  const REGISTERED = 'https://keeper-1.fleet.example/';
  const local = {
    schemaVersion: 1,
    name: 'local-fleet',
    chainId: 43112,
    rpcUrl: 'http://127.0.0.1:9650/ext/bc/C/rpc',
    coordinator: 'assigned-first',
    addresses: { KeyRegistry: `0x${'11'.repeat(20)}`, NodeRegistry: `0x${'22'.repeat(20)}` },
    verifierAgentUrl: 'https://localhost:19444',
    keeperUrls: { [REGISTERED]: 'http://127.0.0.1:8091' },
  };

  it('points the build at an application deployment and keeps its own coordinator', async () => {
    const { resolveTasraDeployment } = await loadDeployment(JSON.stringify(local));
    const { deployment, verifierAgentUrl } = resolveTasraDeployment();
    expect(deployment.chainId).toBe(43112);
    expect(deployment.coordinator).toBe('assigned-first');
    expect(verifierAgentUrl).toBe('https://localhost:19444');
  });

  it('routes a registered keeper URL to the reachable one the manifest maps it to, and no other', async () => {
    const { resolveTasraDeployment } = await loadDeployment(JSON.stringify(local));
    const { keeperUrl } = resolveTasraDeployment();
    expect(keeperUrl?.(REGISTERED)).toBe('http://127.0.0.1:8091');
    expect(keeperUrl?.('https://keeper-2.fleet.example/')).toBe('https://keeper-2.fleet.example/');
  });

  it('refuses an override that is not JSON', async () => {
    const { resolveTasraDeployment } = await loadDeployment('{not json');
    expect(() => resolveTasraDeployment()).toThrow('VITE_TASRA_NETWORK_MANIFEST is not valid JSON');
  });
});
