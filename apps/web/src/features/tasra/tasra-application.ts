import { createTasra, type TasraApplication } from '@t3foundry/tasra-sdk/app';

import { resolveTasraDeployment } from './deployment';

/**
 * The application client, created once and shared by everybody who talks to Tasra.
 *
 * Construction is deferred to first access: importing this module never
 * resolves the manifest, so a malformed manifest only fails when code actually
 * reaches for the application, not on import.
 */
let instance: TasraApplication | undefined;

export const getTasraApplication = (): TasraApplication => {
  if (!instance) {
    // The manifest's keeper routing (a local fleet's registered URL → reachable URL map) applies
    // to every keeper request the application makes.
    const { deployment, keeperUrl } = resolveTasraDeployment();
    instance = createTasra({ deployment, ...(keeperUrl ? { keeperUrl } : {}) });
  }
  return instance;
};
