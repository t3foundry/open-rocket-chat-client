import { createTasra, type TasraApplication } from '@t3foundry/tasra-sdk/app';

import { getDeployment } from './deployment';

/**
 * The application client, created once and shared by everybody who talks to Tasra.
 *
 * Construction is deferred to first access: importing this module never
 * resolves the manifest, so a malformed manifest only fails when code actually
 * reaches for the application, not on import.
 */
let instance: TasraApplication | undefined;

export const getTasraApplication = (): TasraApplication =>
  (instance ??= createTasra({ deployment: getDeployment() }));
