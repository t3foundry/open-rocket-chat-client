import { describe, expect, it, vi } from 'vitest';

// The browser transports are not under test, and importing them is all this module does at load.
vi.mock('@t3foundry/tasra-sdk/app/browser', () => ({
  createBrowserAgentTransport: vi.fn(),
  createIndexedDbStore: vi.fn(),
}));

import { approvedAgentProfile, defaultVerificationPolicy } from '../session-config';

describe('defaultVerificationPolicy', () => {
  it('is unset when the build names none', () => {
    expect(defaultVerificationPolicy('')).toBeUndefined();
  });

  it('reads <committee>/<quorum>', () => {
    expect(defaultVerificationPolicy('3/2')).toEqual({ committee: 3, quorum: 2 });
  });

  it.each(['3', '2/3', '0/0', '3/2/1', 'three/two'])('refuses %s', (value) => {
    expect(() => defaultVerificationPolicy(value)).toThrow(/VITE_TASRA_VERIFIER_POLICY/);
  });
});

describe('approvedAgentProfile', () => {
  it('says which setting is missing', () => {
    expect(() => approvedAgentProfile('', 43113)).toThrow(/VITE_TASRA_AGENT_PROFILE is not set/);
  });

  it('refuses a document that is not a service-profiles document', () => {
    expect(() => approvedAgentProfile('{"verifierAgents":[]}', 43113)).toThrow();
  });
});
