import { create } from 'zustand';

/**
 * The slot creator's EVM private key, persisted in localStorage so it can be
 * set at runtime through Settings rather than only at build time.
 *
 * The verifier agent expects every decrypt/sign operation to carry an EIP-712
 * signature from the slot's on-chain creator.  That means every client must
 * share the same key — it is a deployment credential, not a per-user secret.
 *
 * Follows the same pattern as the GIPHY API key store in
 * {@link ../messages/giphy.ts}: a zustand store backed by localStorage, with
 * the build-time `VITE_CREATOR_KEY` env var as the fallback.
 */

const KEY_STORAGE = 'orc:tasra-creator-key';

/** The key shipped at build time, if any. */
const buildTimeKey = ((import.meta.env.VITE_CREATOR_KEY as string | undefined) ?? '').trim();

/** True when the deployment shipped a creator key. */
export const hasBuildTimeCreatorKey = buildTimeKey.length > 0;

const readStoredKey = (): string => {
  try {
    return localStorage.getItem(KEY_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
};

interface CreatorKeyState {
  /** The key entered in Settings. Empty means "use the build-time key". */
  userKey: string;
  setUserKey: (key: string) => void;
}

export const useCreatorKeyStore = create<CreatorKeyState>((set) => ({
  userKey: readStoredKey(),

  setUserKey: (key) => {
    const userKey = key.trim();

    try {
      if (userKey) localStorage.setItem(KEY_STORAGE, userKey);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      // Storage is unavailable in some privacy modes.  The key still applies
      // for this session.
    }

    set({ userKey });
  },
}));

/**
 * The creator key in force: whatever was entered in Settings, else the
 * build-time `VITE_CREATOR_KEY`.  Returns `undefined` when neither is set.
 */
export const useCreatorKey = (): `0x${string}` | undefined => {
  const userKey = useCreatorKeyStore((state) => state.userKey);
  const key = userKey || buildTimeKey;
  return key ? (key as `0x${string}`) : undefined;
};