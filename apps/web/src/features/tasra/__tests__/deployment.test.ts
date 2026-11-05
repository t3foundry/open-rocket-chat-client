import { describe, expect, it } from 'vitest';

import { getDeployment, getVerifierAgentUrl, resolveTasraDeployment } from '../deployment';
import rawNetwork from '../network.json';

describe('resolveTasraDeployment', () => {
  it('resolves the checked-in manifest to the chain it names', () => {
    expect(resolveTasraDeployment().deployment.chainId).toBe(rawNetwork.chainId);
  });
});

describe('getDeployment', () => {
  it('names the KeyRegistry contract from the manifest', () => {
    expect(getDeployment().addresses.KeyRegistry?.toLowerCase()).toBe('0x45f432ab5709e9920b5ec349d29663d7200a8c39');
  });

  it('points at an https RPC endpoint', () => {
    expect(getDeployment().rpcUrl).toMatch(/^https:\/\//);
  });

  it('carries the chain id the manifest declares', () => {
    expect(getDeployment().chainId).toBe(rawNetwork.chainId);
  });
});

describe('getVerifierAgentUrl', () => {
  it('is the verifier-agent service the manifest advertises', () => {
    expect(getVerifierAgentUrl()).toBe('https://agent.t3-foundry.fuji.tasra.network');
  });
});
